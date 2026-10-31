(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const videoInput = $("#videoInput");
  const scriptFileInput = $("#scriptInput");
  const scriptEditor = $("#scriptInputText");
  const sourceVideo = $("#sourceVideo");
  const voiceOverInput = $("#voiceOverInput");
  const voiceOverTracks = [];
  const voiceOverAudioContainer = $("#voiceOverTracks");
  const voiceOverMediaContainer = $("#voiceOverMedia");
  const MAX_VIDEO_DURATION = 10 * 60;
  const INTRO_MAX_SCENE_DURATION = 6;
  const MAIN_MAX_SCENE_DURATION = 13;
  const AUTOSAVE_DATABASE = "scene-studio";
  const AUTOSAVE_STORE = "projects";
  const AUTOSAVE_ID = "current-project";
  const canvas = $("#previewCanvas");
  const ctx = canvas.getContext("2d");
  const clips = [];
  let scenes = [];
  let currentSceneIndex = 0;
  let isPlaying = false;
  let playbackToken = 0;
  let renderToken = 0;
  let toastTimer;
  let previewFrame;
  let audioContext;
  let audioDestination;
  let aspectRatio = "16:9";
  let frameRate = 24;
  let editingPreset = "custom";
  let transitionDuration = 0;
  let fitMode = "blur";
  let libraryLoads = {};
  let transformersModulePromise;
  let autosaveDatabasePromise;
  let autosaveTimer;
  let autosaveWrite = Promise.resolve();
  let autosaveEnabled = false;
  let isRestoringAutosave = false;
  let autosaveRevision = 0;
  const aiPipelines = new Map();
  const commonsStopWords = new Set(["a", "about", "act", "after", "again", "along", "also", "an", "and", "are", "around", "as", "at", "be", "beside", "by", "camp", "camping", "down", "drive", "driving", "finally", "for", "from", "go", "in", "into", "is", "it", "its", "just", "near", "of", "on", "or", "over", "reach", "reaches", "scene", "shot", "start", "starts", "then", "there", "they", "this", "through", "to", "under", "up", "we", "with", "you", "your"]);

  const formatTime = (seconds) => {
    const safe = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
  };
  const formatClipTime = (seconds) => {
    const tenths = Math.round(Math.max(0, Number(seconds) || 0) * 10);
    return `${formatTime(Math.floor(tenths / 10))}.${tenths % 10}`;
  };
  const safeDuration = (clip) => Number.isFinite(clip?.duration) && clip.duration > 0 ? clip.duration : 5;
  const toast = (message) => {
    const element = $("#toast");
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("show"), 2800);
  };
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const totalTime = () => scenes.reduce((sum, scene) => sum + Number(scene.duration || 0), 0);
  const totalVoiceOverDuration = () => voiceOverTracks.reduce((sum, track) => sum + (track.loading ? 0 : track.duration), 0);
  const hasVoiceOvers = () => voiceOverTracks.length > 0;
  const voiceOversLoading = () => voiceOverTracks.some((track) => track.loading);
  const sceneDurationLimit = () => hasVoiceOvers() && !voiceOversLoading() && totalVoiceOverDuration() > 0
    ? totalVoiceOverDuration()
    : MAX_VIDEO_DURATION;
  const sceneDurationCap = (scene) => scene.segmentType === "intro" ? INTRO_MAX_SCENE_DURATION : MAIN_MAX_SCENE_DURATION;

  function setSaveStatus(message, state) {
    const status = $("#savedStatus");
    status.textContent = message;
    status.dataset.state = state;
    status.title = "";
  }

  function openAutosaveDatabase() {
    if (!window.indexedDB) return Promise.reject(new Error("This browser does not support local project storage."));
    if (!autosaveDatabasePromise) {
      autosaveDatabasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(AUTOSAVE_DATABASE, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(AUTOSAVE_STORE)) {
            request.result.createObjectStore(AUTOSAVE_STORE, { keyPath: "id" });
          }
        };
        request.onsuccess = () => {
          request.result.onversionchange = () => request.result.close();
          resolve(request.result);
        };
        request.onerror = () => reject(request.error || new Error("Could not open browser project storage."));
        request.onblocked = () => reject(new Error("Browser project storage is blocked by another open editor tab."));
      }).catch((error) => {
        autosaveDatabasePromise = null;
        throw error;
      });
    }
    return autosaveDatabasePromise;
  }

  function autosaveRecord() {
    return {
      id: AUTOSAVE_ID,
      savedAt: new Date().toISOString(),
      projectName: $("#projectNameLabel").textContent,
      script: scriptEditor.value,
      aspectRatio,
      frameRate,
      editingPreset,
      transitionDuration,
      fitMode,
      visualSourceMode: visualSourceMode(),
      scenes: scenes.map((scene) => ({ ...scene })),
      clips: clips.map((clip) => ({
        id: clip.id,
        name: clip.name,
        kind: clip.kind || "video",
        duration: safeDuration(clip),
        size: clip.size || clip.file?.size || 0,
        attribution: clip.attribution || null,
        onlineGenerated: Boolean(clip.onlineGenerated),
        blob: clip.file || clip.blob || null
      })),
      voiceOvers: voiceOverTracks.map((track) => ({
        name: track.file.name,
        type: track.file.type,
        lastModified: track.file.lastModified,
        blob: track.file,
        volume: Number($("#voiceOverVolume").value)
      })),
      voiceOverVolume: Number($("#voiceOverVolume").value)
    };
  }

  function requestAutosave() {
    if (!autosaveEnabled || isRestoringAutosave) return;
    clearTimeout(autosaveTimer);
    setSaveStatus("Saving changes…", "saving");
    const revision = ++autosaveRevision;
    autosaveTimer = setTimeout(() => {
      const record = autosaveRecord();
      autosaveWrite = autosaveWrite.then(async () => {
        const database = await openAutosaveDatabase();
        await new Promise((resolve, reject) => {
          const transaction = database.transaction(AUTOSAVE_STORE, "readwrite");
          transaction.objectStore(AUTOSAVE_STORE).put(record);
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error || new Error("Browser storage rejected the save."));
          transaction.onabort = () => reject(transaction.error || new Error("The project save was interrupted."));
        });
        if (revision === autosaveRevision) setSaveStatus("Saved on this device", "saved");
      }).catch((error) => {
        if (revision === autosaveRevision) {
          console.error("Could not save the project locally.", error);
          setSaveStatus("Unable to keep changes", "error");
          $("#savedStatus").title = error.message;
          toast(`Unable to save changes on this device: ${error.message}`);
        }
      });
    }, 350);
  }

  async function getAutosave() {
    const database = await openAutosaveDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(AUTOSAVE_STORE, "readonly");
      const request = transaction.objectStore(AUTOSAVE_STORE).get(AUTOSAVE_ID);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Could not read the saved project."));
    });
  }

  async function clearAutosave() {
    clearTimeout(autosaveTimer);
    const revision = ++autosaveRevision;
    await autosaveWrite;
    const database = await openAutosaveDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(AUTOSAVE_STORE, "readwrite");
      transaction.objectStore(AUTOSAVE_STORE).delete(AUTOSAVE_ID);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Could not clear the saved project."));
      transaction.onabort = () => reject(transaction.error || new Error("Could not clear the saved project."));
    });
    if (revision === autosaveRevision) setSaveStatus("Changes save on this device", "saved");
  }

  async function restoreAutosave() {
    isRestoringAutosave = true;
    setSaveStatus("Checking saved project…", "saving");
    try {
      const record = await getAutosave();
      if (!record) {
        autosaveEnabled = true;
        setSaveStatus("Changes save on this device", "saved");
        return;
      }

      $("#projectNameLabel").textContent = record.projectName || "Untitled story";
      scriptEditor.value = record.script || "";
      aspectRatio = record.aspectRatio || "16:9";
      frameRate = Number(record.frameRate) || 24;
      editingPreset = record.editingPreset || "custom";
      transitionDuration = Number(record.transitionDuration) || 0;
      fitMode = record.fitMode || "blur";
      $("#aspectButton").innerHTML = `${aspectRatio} <span>⌄</span>`;
      $("#frameRateSelect").value = String(frameRate);
      $("#voiceOverVolume").value = String(record.voiceOverVolume ?? 1);
      $("#voiceOverVolumeLabel").textContent = `${Math.round(Number($("#voiceOverVolume").value) * 100)}%`;
      const modeInput = document.querySelector(`input[name="visualSourceMode"][value="${record.visualSourceMode === "library" ? "library" : "external"}"]`);
      if (modeInput) modeInput.checked = true;
      scenes = Array.isArray(record.scenes) ? record.scenes.map((scene) => ({
        ...scene,
        segmentType: scene.segmentType === "intro" ? "intro" : "main",
        clipId: scene.clipId || ""
      })) : [];
      clips.splice(0, clips.length);
      for (const savedClip of record.clips || []) {
        if (!(savedClip.blob instanceof Blob)) continue;
        const file = new File([savedClip.blob], savedClip.name, { type: savedClip.blob.type || (savedClip.kind === "image" ? "image/jpeg" : "video/mp4") });
        const url = URL.createObjectURL(file);
        const clip = {
          id: savedClip.id || crypto.randomUUID(),
          name: savedClip.name,
          file: savedClip.onlineGenerated ? undefined : file,
          blob: savedClip.onlineGenerated ? file : undefined,
          url,
          kind: savedClip.kind === "image" ? "image" : "video",
          duration: Number(savedClip.duration) || 5,
          size: file.size,
          attribution: savedClip.attribution || null,
          onlineGenerated: Boolean(savedClip.onlineGenerated)
        };
        if (clip.kind === "image") {
          clip.image = new Image();
          clip.image.src = url;
          await clip.image.decode();
        }
        clips.push(clip);
      }

      const savedVoiceOvers = (record.voiceOvers || []).filter((track) => track.blob instanceof Blob);
      if (savedVoiceOvers.length) {
        const files = savedVoiceOvers.map((track) => new File([track.blob], track.name, {
          type: track.type || track.blob.type,
          lastModified: track.lastModified || Date.now()
        }));
        addVoiceOver(files, { quiet: true });
      }
      updateScriptMeta();
      updateVisualSourceMode();
      renderClips();
      renderVoiceOver();
      renderScenes();
      autosaveEnabled = true;
      setSaveStatus("Project restored · saved on this device", "saved");
    } catch (error) {
      console.error("Could not restore the saved project.", error);
      autosaveEnabled = true;
      setSaveStatus("Unable to restore saved changes", "error");
      toast(`Could not restore your saved project: ${error.message}`);
    } finally {
      isRestoringAutosave = false;
    }
  }

  function splitScene(sceneList, index) {
    const scene = sceneList[index];
    const words = scene.script.trim().split(/\s+/).filter(Boolean);
    const splitAt = Math.max(1, Math.ceil(words.length / 2));
    const firstScript = words.length > 1 ? words.slice(0, splitAt).join(" ") : scene.script;
    const secondScript = words.length > 1 ? words.slice(splitAt).join(" ") : scene.script;
    const originalTitle = scene.title || `Scene ${index + 1}`;
    const originalDuration = Number(scene.duration) || 0.2;
    const firstDuration = originalDuration / 2;
    const wasIntro = scene.segmentType === "intro";
    scene.script = firstScript;
    scene.title = firstScript ? firstScript.split(/\s+/).slice(0, 7).join(" ").slice(0, 50) : originalTitle;
    scene.duration = firstDuration;
    scene.segmentType = wasIntro ? "intro" : "main";

    const continuation = {
      ...scene,
      id: crypto.randomUUID(),
      title: secondScript && words.length > 1
        ? secondScript.split(/\s+/).slice(0, 7).join(" ").slice(0, 50)
        : `${originalTitle} (continued)`.slice(0, 50),
      script: secondScript,
      duration: originalDuration - firstDuration,
      segmentType: "main",
      clipIn: 0,
      matchScore: null
    };
    sceneList.splice(index + 1, 0, continuation);
  }

  function ensureSceneCapacity(sceneList, targetDuration) {
    let safety = 0;
    while (sceneList.reduce((sum, scene) => sum + sceneDurationCap(scene), 0) < targetDuration - 0.001) {
      if (!sceneList.length || safety++ > 1000) throw new Error("Could not create enough scenes to fit the voice-over within the clip duration limits.");
      const splitIndex = sceneList.reduce((bestIndex, scene, index, list) =>
        !sceneList[bestIndex] || Number(scene.duration) > Number(list[bestIndex].duration) ? index : bestIndex, -1);
      splitScene(sceneList, splitIndex);
    }
  }

  function distributeSceneDurations(sceneList, targetDuration = sceneDurationLimit(), fixedIndex = -1, fixedDuration = 0) {
    if (!sceneList.length) return;
    const fixedScene = fixedIndex < 0 ? null : sceneList[fixedIndex];
    ensureSceneCapacity(sceneList, targetDuration);
    if (fixedScene) fixedIndex = sceneList.indexOf(fixedScene);
    const minDuration = Math.min(0.1, targetDuration / sceneList.length);
    const fixedValue = fixedScene
      ? Math.min(sceneDurationCap(fixedScene), Math.max(minDuration, Math.min(targetDuration, Number(fixedDuration) || minDuration)))
      : 0;
    const adjustable = sceneList
      .map((scene, index) => ({ scene, index }))
      .filter(({ index }) => !fixedScene || index !== fixedIndex);
    const allocations = new Map();
    if (fixedScene) allocations.set(fixedIndex, fixedValue);
    adjustable.forEach(({ scene, index }) => allocations.set(index, minDuration));
    let remaining = Math.max(0, targetDuration - [...allocations.values()].reduce((sum, value) => sum + value, 0));
    let active = adjustable.filter(({ scene }) => sceneDurationCap(scene) > minDuration);
    while (remaining > 0.001 && active.length) {
      const totalWeight = active.reduce((sum, { scene }) => sum + Math.max(0.1, Number(scene.duration) || 5), 0);
      let consumed = 0;
      const nextActive = [];
      active.forEach(({ scene, index }) => {
        const current = allocations.get(index);
        const proposed = remaining * Math.max(0.1, Number(scene.duration) || 5) / totalWeight;
        const increment = Math.min(proposed, sceneDurationCap(scene) - current);
        allocations.set(index, current + increment);
        consumed += increment;
        if (sceneDurationCap(scene) - (current + increment) > 0.001) nextActive.push({ scene, index });
      });
      if (consumed < 0.001) break;
      remaining -= consumed;
      active = nextActive;
    }
    sceneList.forEach((scene, index) => { scene.duration = allocations.get(index) || minDuration; });
  }

  function seekVideo(seconds) {
    const target = Math.max(0, Number(seconds) || 0);
    if (sourceVideo.readyState >= 2 && Math.abs(sourceVideo.currentTime - target) < 0.04) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out while seeking in the video."));
      }, 10000);
      const cleanup = () => {
        clearTimeout(timeout);
        sourceVideo.removeEventListener("seeked", onSeeked);
        sourceVideo.removeEventListener("error", onError);
      };
      const onSeeked = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error("Unable to seek in the video.")); };
      sourceVideo.addEventListener("seeked", onSeeked, { once: true });
      sourceVideo.addEventListener("error", onError, { once: true });
      try { sourceVideo.currentTime = target; }
      catch (error) { cleanup(); reject(error); }
    });
  }

  function renderVoiceOver() {
    const emptyStatus = $("#voiceOverEmptyStatus");
    emptyStatus.hidden = hasVoiceOvers();
    const totalStatus = $("#voiceOverTotal");
    totalStatus.hidden = !hasVoiceOvers();
    totalStatus.textContent = voiceOversLoading()
      ? `${voiceOverTracks.length} voice-over file${voiceOverTracks.length === 1 ? "" : "s"} · reading duration…`
      : `${voiceOverTracks.length} voice-over file${voiceOverTracks.length === 1 ? "" : "s"} · combined length ${formatTime(totalVoiceOverDuration())}`;
    voiceOverAudioContainer.innerHTML = voiceOverTracks.map((track) => `<div class="voiceover-file" data-voiceover-id="${track.id}">
      <span class="voiceover-icon">♫</span>
      <div class="voiceover-copy"><strong title="${escapeHtml(track.file.name)}">${escapeHtml(track.file.name)}</strong><span>${track.loading ? "Loading audio…" : track.error || `${formatTime(track.duration)} · VOICE-OVER`}</span></div>
      <button class="voiceover-play" data-preview-voiceover="${track.id}" aria-label="Preview ${escapeHtml(track.file.name)}" ${track.loading || track.error ? "disabled" : ""}>▶ Preview</button>
      <button class="clip-remove" data-remove-voiceover="${track.id}" aria-label="Remove ${escapeHtml(track.file.name)}" title="Remove voice-over">×</button>
    </div>`).join("");
    requestAutosave();
  }

  function addVoiceOver(fileList, { quiet = false } = {}) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let added = 0;
    files.forEach((file) => {
      const mimeType = String(file.type || "").trim().toLowerCase();
      const looksLikeAudio = mimeType.startsWith("audio/")
        || /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(String(file.name || "").trim());
      const track = {
        id: crypto.randomUUID(),
        file,
        url: URL.createObjectURL(file),
        audio: document.createElement("audio"),
        duration: 0,
        loading: true,
        error: "",
        source: null,
        looksLikeAudio
      };
      track.audio.preload = "metadata";
      track.audio.volume = Number($("#voiceOverVolume").value);
      track.audio.muted = false;
      track.audio.hidden = true;
      voiceOverMediaContainer.appendChild(track.audio);
      track.audio.src = track.url;
      track.audio.addEventListener("loadedmetadata", () => {
        track.loading = false;
        track.duration = Number.isFinite(track.audio.duration) ? track.audio.duration : 0;
        if (audioContext) connectVoiceOverTrack(track);
        if (scenes.length && !voiceOversLoading()) distributeSceneDurations(scenes, sceneDurationLimit());
        renderVoiceOver();
        renderScenes();
        if (!quiet && scenes.length && !voiceOversLoading()) toast(`Scene timings matched to the combined ${formatTime(totalVoiceOverDuration())} voice-over.`);
      }, { once: true });
      track.audio.addEventListener("ended", () => {
        const button = voiceOverAudioContainer.querySelector(`[data-preview-voiceover="${track.id}"]`);
        if (button) button.textContent = "▶ Preview";
      });
      track.audio.addEventListener("error", () => {
        track.loading = false;
        const errorCode = track.audio.error?.code;
        track.error = errorCode === 4
          ? track.looksLikeAudio ? "Unsupported audio codec" : "This file is not a supported audio format"
          : errorCode === 3
            ? "Audio file could not be decoded"
            : "Could not read this audio file";
        URL.revokeObjectURL(track.url);
        if (scenes.length && !voiceOversLoading()) distributeSceneDurations(scenes, sceneDurationLimit());
        renderVoiceOver();
        renderScenes();
        toast(`Could not load "${file.name}": ${track.error}. Try another MP3 or WAV copy.`);
      }, { once: true });
      track.audio.load();
      voiceOverTracks.push(track);
      added++;
    });
    renderVoiceOver();
    if (added && !quiet) toast(`${added} file${added === 1 ? "" : "s"} added to voice-over. Checking audio…`);
  }

  function removeVoiceOver(id) {
    const index = voiceOverTracks.findIndex((track) => track.id === id);
    if (index < 0) return;
    const [track] = voiceOverTracks.splice(index, 1);
    track.audio.pause();
    if (track.source) {
      track.source.disconnect();
      track.source = null;
    }
    track.audio.remove();
    URL.revokeObjectURL(track.url);
    if (scenes.length && hasVoiceOvers() && !voiceOversLoading()) distributeSceneDurations(scenes, sceneDurationLimit());
    else if (scenes.length && !hasVoiceOvers()) limitSceneDurations(scenes);
    renderVoiceOver();
    renderScenes();
    toast(`Removed "${track.file.name}".`);
  }

  async function previewVoiceOver(id) {
    const track = voiceOverTracks.find((item) => item.id === id);
    if (!track || track.loading || track.error) return;
    if (!track.audio.paused) {
      track.audio.pause();
      return;
    }
    try {
      stopVoiceOvers();
      track.audio.volume = Number($("#voiceOverVolume").value);
      await seekVoiceOver(track, 0);
      await track.audio.play();
      const button = voiceOverAudioContainer.querySelector(`[data-preview-voiceover="${track.id}"]`);
      if (button) button.textContent = "Ⅱ Pause";
    } catch (error) {
      toast(`Unable to play "${track.file.name}": ${error.message || "audio playback failed"}`);
    }
  }

  function drawCover(video) {
    const mediaWidth = video.videoWidth || video.naturalWidth;
    const mediaHeight = video.videoHeight || video.naturalHeight;
    if (!mediaWidth || !mediaHeight) return;
    ctx.save();
    ctx.filter = "blur(24px) brightness(0.55)";
    const coverScale = Math.max(canvas.width / mediaWidth, canvas.height / mediaHeight);
    const coverWidth = mediaWidth * coverScale;
    const coverHeight = mediaHeight * coverScale;
    ctx.drawImage(video, (canvas.width - coverWidth) / 2, (canvas.height - coverHeight) / 2, coverWidth, coverHeight);
    ctx.restore();
    const fitScale = Math.min(canvas.width / mediaWidth, canvas.height / mediaHeight);
    const fitWidth = mediaWidth * fitScale;
    const fitHeight = mediaHeight * fitScale;
    ctx.drawImage(video, (canvas.width - fitWidth) / 2, (canvas.height - fitHeight) / 2, fitWidth, fitHeight);
    if (currentSceneIndex >= 0 && scenes[currentSceneIndex]) {
      const scene = scenes[currentSceneIndex];
      const caption = scene.script.trim().replace(/\s+/g, " ");
      if (caption) {
        const fontSize = Math.round(canvas.width * 0.027);
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,.52)";
        ctx.fillRect(0, canvas.height - fontSize * 3.2, canvas.width, fontSize * 3.2);
        ctx.fillStyle = "#ffffff";
        ctx.font = `600 ${fontSize}px "DM Sans", sans-serif`;
        ctx.textBaseline = "middle";
        const maxWidth = canvas.width * 0.9;
        const words = caption.split(" ");
        const lines = [];
        let line = "";
        for (const word of words) {
          const next = line ? `${line} ${word}` : word;
          if (ctx.measureText(next).width > maxWidth && line) {
            lines.push(line);
            line = word;
          } else line = next;
          if (lines.length === 2) break;
        }
        if (line && lines.length < 2) lines.push(line);
        const firstY = canvas.height - fontSize * 2.2;
        lines.forEach((text, index) => ctx.fillText(text, canvas.width * 0.05, firstY + index * fontSize * 1.3, maxWidth));
        ctx.restore();
      }
    }
    const attribution = scenes[currentSceneIndex]?.visualAttribution;
    if (attribution) {
      ctx.save();
      const fontSize = Math.max(12, Math.round(canvas.width * 0.012));
      ctx.font = `500 ${fontSize}px "DM Sans", sans-serif`;
      const credit = `${attribution.mediaType === "video" ? "Video" : "Photo"}: ${attribution.creator || attribution.provider} · ${attribution.provider} · ${attribution.license}`;
      const width = Math.min(ctx.measureText(credit).width + fontSize, canvas.width * 0.9);
      ctx.fillStyle = "rgba(0,0,0,.62)";
      ctx.fillRect(canvas.width * 0.04, canvas.height - fontSize * 2.4, width, fontSize * 1.8);
      ctx.fillStyle = "#ffffff";
      ctx.textBaseline = "middle";
      ctx.fillText(credit, canvas.width * 0.06, canvas.height - fontSize * 1.5, width - fontSize * 0.3);
      ctx.restore();
    }
  }

  function startPreviewDrawing(transitionFrom = null) {
    cancelAnimationFrame(previewFrame);
    const transitionStarted = performance.now();
    const draw = () => {
      const clip = clips.find((item) => item.id === scenes[currentSceneIndex]?.clipId);
      if (clip?.kind === "image" || (sourceVideo.readyState >= 2 && !sourceVideo.paused)) {
        drawCover(clip?.kind === "image" ? clip.image : sourceVideo);
        const transitionProgress = transitionFrom ? Math.min(1, (performance.now() - transitionStarted) / (transitionDuration * 1000)) : 1;
        if (transitionFrom && transitionProgress < 1) {
          ctx.save();
          ctx.globalAlpha = 1 - transitionProgress;
          ctx.drawImage(transitionFrom, 0, 0, canvas.width, canvas.height);
          ctx.restore();
        }
      }
      if (isPlaying) previewFrame = requestAnimationFrame(draw);
    };
    previewFrame = requestAnimationFrame(draw);
  }

  function setSceneSource(scene, seekToStart = true) {
    const clip = clips.find((item) => item.id === scene?.clipId);
    $("#previewPlaceholder").hidden = Boolean(clip);
    $("#previewSceneLabel").textContent = scene ? `SCENE ${String(currentSceneIndex + 1).padStart(2, "0")}  ·  ${scene.title.toUpperCase()}` : "READY WHEN YOU ARE";
    $("#nowPlayingText").textContent = scene ? (clip ? clip.name : "Choose footage for this scene") : "Your video preview will appear here";
    if (!clip) {
      sourceVideo.pause();
      sourceVideo.removeAttribute("src");
      sourceVideo.load();
      ctx.fillStyle = "#151713";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (clip.kind === "image") {
      sourceVideo.pause();
      sourceVideo.removeAttribute("src");
      sourceVideo.dataset.clipId = "";
      sourceVideo.load();
      drawCover(clip.image);
      return;
    }
    if (sourceVideo.dataset.clipId !== clip.id) {
      sourceVideo.pause();
      sourceVideo.src = clip.url;
      sourceVideo.dataset.clipId = clip.id;
      sourceVideo.load();
    }
    const inPoint = Math.min(Number(scene.clipIn) || 0, Math.max(0, safeDuration(clip) - 0.1));
    const seek = () => {
      if (seekToStart && Number.isFinite(sourceVideo.duration)) {
        try { sourceVideo.currentTime = Math.min(inPoint, Math.max(0, sourceVideo.duration - 0.1)); } catch {}
      }
      if (sourceVideo.readyState >= 2) drawCover(sourceVideo);
    };
    if (sourceVideo.readyState >= 1) seek();
    else sourceVideo.addEventListener("loadedmetadata", seek, { once: true });
  }

  function renderClips() {
    $("#clipCount").textContent = clips.length;
    const list = $("#clipList");
    if (!clips.length) {
      list.innerHTML = '<div class="empty-library"><span>▱</span><p>Your clips will show up here</p></div>';
      requestAutosave();
      return;
    }
    list.innerHTML = clips.map((clip) => `<div class="clip-row" draggable="true" data-kind="${clip.kind || "video"}" data-clip-id="${clip.id}">
      <div class="clip-thumb">${clip.kind === "image" ? `<img src="${clip.url}" alt="">` : `<video src="${clip.url}" muted preload="metadata"></video>`}</div>
      <div><div class="clip-name" title="${escapeHtml(clip.name)}">${escapeHtml(clip.name)}</div><span class="clip-duration">${formatTime(safeDuration(clip))} · ${clip.kind === "image" ? "PHOTO" : "VIDEO"}${clip.attribution ? ` · ${escapeHtml(clip.attribution.provider)}` : ""}</span></div>
      <button class="clip-remove" data-remove-clip="${clip.id}" aria-label="Remove ${escapeHtml(clip.name)}" title="Remove clip">×</button>
    </div>`).join("");
    list.querySelectorAll(".clip-row").forEach((row) => {
      row.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", row.dataset.clipId);
        event.dataTransfer.effectAllowed = "copy";
      });
    });
    list.querySelectorAll("[data-remove-clip]").forEach((button) => button.addEventListener("click", () => removeClip(button.dataset.removeClip)));
    requestAutosave();
  }

  function renderScenes() {
    const list = $("#sceneList");
    $("#sceneCount").textContent = `${scenes.length} scene${scenes.length === 1 ? "" : "s"}`;
    $("#totalDuration").textContent = formatTime(totalTime());
    $("#timelineEmpty").hidden = scenes.length > 0;
    if (!scenes.length) {
      list.innerHTML = "";
      updateCurrentScene();
      requestAutosave();
      return;
    }
    list.innerHTML = scenes.map((scene, index) => {
      const otherSceneDuration = totalTime() - Number(scene.duration || 0);
      const minDuration = hasVoiceOvers() && !voiceOversLoading() ? Math.min(0.1, sceneDurationLimit() / scenes.length) : 1;
      const maxDuration = Math.max(minDuration, Math.min(sceneDurationCap(scene), sceneDurationLimit() - otherSceneDuration));
      return `<article class="scene-card" data-scene-id="${scene.id}">
      <div class="scene-index">${String(index + 1).padStart(2, "0")}</div>
      <div class="scene-copy">
        <div class="scene-title"><input aria-label="Scene ${index + 1} title" value="${escapeHtml(scene.title)}" data-scene-title="${scene.id}"><button class="scene-delete" data-remove-scene="${scene.id}" title="Remove scene" aria-label="Remove scene">×</button></div>
        <div class="scene-script">${escapeHtml(scene.script)}</div>
        ${Number.isFinite(scene.matchScore) ? `<div class="scene-match">Source cut ${formatClipTime(scene.clipIn)}–${formatClipTime(Math.min(safeDuration(clips.find((clip) => clip.id === scene.clipId)), Number(scene.clipIn) + Number(scene.duration)))} · AI match ${Math.round(scene.matchScore * 100)}%</div>` : ""}
        ${scene.visualAttribution ? `<div class="visual-credit">${escapeHtml(scene.visualAttribution.mediaType === "video" ? "Video" : "Photo")}: ${escapeHtml(scene.visualAttribution.creator || scene.visualAttribution.provider)} · ${escapeHtml(scene.visualAttribution.provider)}${scene.visualAttribution.license ? ` · ${escapeHtml(scene.visualAttribution.license)}` : ""} · <a href="${escapeHtml(scene.visualAttribution.sourceUrl)}" target="_blank" rel="noopener noreferrer">Source</a>${scene.visualAttribution.licenseUrl ? ` · <a href="${escapeHtml(scene.visualAttribution.licenseUrl)}" target="_blank" rel="noopener noreferrer">License</a>` : ""}</div>` : ""}
        <div class="scene-settings"><label>Part <select aria-label="Scene ${index + 1} type" data-scene-type="${scene.id}"><option value="intro" ${scene.segmentType === "intro" ? "selected" : ""}>Intro · 6s max</option><option value="main" ${scene.segmentType !== "intro" ? "selected" : ""}>Main · 13s max</option></select></label><label>Duration <input type="number" min="${minDuration}" max="${maxDuration}" step="0.5" value="${Number(scene.duration) || 5}" data-scene-duration="${scene.id}" ${hasVoiceOvers() && scenes.length === 1 ? 'disabled title="The single scene matches the full voice-over duration, within its clip limit."' : ""}> sec</label><label>Clip start <input type="number" min="0" max="9999" step="0.5" value="${Number(scene.clipIn) || 0}" data-scene-in="${scene.id}"> sec</label></div>
      </div>
      <select class="scene-video-select" aria-label="Footage for scene ${index + 1}" data-scene-clip="${scene.id}">
        <option value="">＋ Choose footage</option>${clips.map((clip) => `<option value="${clip.id}" ${clip.id === scene.clipId ? "selected" : ""}>${escapeHtml(clip.name)}</option>`).join("")}
      </select>
    </article>`;
    }).join("");
    list.querySelectorAll("[data-scene-title]").forEach((input) => input.addEventListener("input", () => {
      const scene = scenes.find((item) => item.id === input.dataset.sceneTitle);
      if (scene) { scene.title = input.value; updateCurrentScene(); requestAutosave(); }
    }));
    list.querySelectorAll("[data-scene-duration]").forEach((input) => input.addEventListener("change", () => {
      const scene = scenes.find((item) => item.id === input.dataset.sceneDuration);
      if (scene) {
        const sceneIndex = scenes.indexOf(scene);
        const otherSceneDuration = totalTime() - Number(scene.duration || 0);
        const minDuration = hasVoiceOvers() && !voiceOversLoading() ? Math.min(0.1, sceneDurationLimit() / scenes.length) : 1;
        const maxDuration = Math.max(minDuration, Math.min(sceneDurationCap(scene), sceneDurationLimit() - otherSceneDuration));
        const requestedDuration = Number(input.value) || 5;
        scene.duration = Math.max(minDuration, Math.min(maxDuration, requestedDuration));
        scene.matchScore = null;
        if (hasVoiceOvers() && !voiceOversLoading()) distributeSceneDurations(scenes, sceneDurationLimit(), sceneIndex, scene.duration);
        input.value = scene.duration;
        renderScenes();
        if (scene.duration < requestedDuration) {
          const availableDuration = sceneDurationLimit() - otherSceneDuration;
          toast(sceneDurationCap(scene) <= availableDuration
            ? `This ${scene.segmentType === "intro" ? "intro" : "main"} clip is limited to ${sceneDurationCap(scene)} seconds.`
            : "Scene duration adjusted so the full voice-over still fits.");
        }
      }
    }));
    list.querySelectorAll("[data-scene-type]").forEach((input) => input.addEventListener("change", () => {
      const scene = scenes.find((item) => item.id === input.dataset.sceneType);
      if (!scene) return;
      scene.segmentType = input.value;
      if (hasVoiceOvers() && !voiceOversLoading()) {
        distributeSceneDurations(scenes, sceneDurationLimit(), scenes.indexOf(scene), scene.duration);
      } else {
        scene.duration = Math.min(Number(scene.duration) || 5, sceneDurationCap(scene));
        limitSceneDurations(scenes);
      }
      renderScenes();
    }));
    list.querySelectorAll("[data-scene-in]").forEach((input) => input.addEventListener("change", () => {
      const scene = scenes.find((item) => item.id === input.dataset.sceneIn);
      if (scene) {
        scene.clipIn = Math.max(0, Number(input.value) || 0);
        scene.matchScore = null;
        input.value = scene.clipIn;
        renderScenes();
        if (scenes[currentSceneIndex]?.id === scene.id) setSceneSource(scene);
      }
    }));
    list.querySelectorAll("[data-scene-clip]").forEach((select) => {
      select.addEventListener("change", () => {
        const scene = scenes.find((item) => item.id === select.dataset.sceneClip);
        if (scene) {
          scene.clipId = select.value;
          scene.visualAttribution = clips.find((clip) => clip.id === select.value)?.attribution || null;
          scene.matchScore = null;
          renderScenes();
          if (scenes[currentSceneIndex]?.id === scene.id) setSceneSource(scene);
        }
      });
      select.addEventListener("dragover", (event) => { event.preventDefault(); select.classList.add("dragging"); });
      select.addEventListener("dragleave", () => select.classList.remove("dragging"));
      select.addEventListener("drop", (event) => {
        event.preventDefault();
        select.classList.remove("dragging");
        const scene = scenes.find((item) => item.id === select.dataset.sceneClip);
        if (scene) {
          scene.clipId = event.dataTransfer.getData("text/plain");
          scene.visualAttribution = clips.find((clip) => clip.id === scene.clipId)?.attribution || null;
          scene.matchScore = null;
          renderScenes();
          if (scenes[currentSceneIndex]?.id === scene.id) setSceneSource(scene);
        }
      });
    });
    list.querySelectorAll("[data-remove-scene]").forEach((button) => button.addEventListener("click", () => {
      scenes = scenes.filter((scene) => scene.id !== button.dataset.removeScene);
      if (currentSceneIndex >= scenes.length) currentSceneIndex = Math.max(0, scenes.length - 1);
      if (hasVoiceOvers() && !voiceOversLoading()) distributeSceneDurations(scenes, sceneDurationLimit());
      renderScenes();
    }));
    list.querySelectorAll(".scene-card").forEach((card, index) => card.addEventListener("click", (event) => {
      if (event.target.closest("input,select,button")) return;
      currentSceneIndex = index;
      updateCurrentScene();
    }));
    updateCurrentScene();
    requestAutosave();
  }

  function updateCurrentScene() {
    const scene = scenes[currentSceneIndex];
    setSceneSource(scene);
    $("#previewTimecode").textContent = formatTime(scene?.clipIn || 0);
  }

  function extractScenes(text) {
    const normalized = text.replace(/\r/g, "").trim();
    if (!normalized) return [];
    const labeledParts = normalized.split(/(?=^[ \t]*(?:scene|act|shot)\s*(?:\d+|[ivx]+)\s*[:.-])/im).map((part) => part.trim()).filter(Boolean);
    const hasLabeledScenes = labeledParts.some((part) => /^(?:scene|act|shot)\s*(?:\d+|[ivx]+)\s*[:.-]\s*.+$/i.test(part.split("\n")[0].trim()));
    const parts = hasLabeledScenes
      ? labeledParts
      : normalized.split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
    return parts.map((part, index) => {
      const lines = part.split("\n").map((line) => line.trim()).filter(Boolean);
      const first = lines[0] || `Scene ${index + 1}`;
      const label = first.match(/^(?:scene|act|shot)\s*(?:\d+|[ivx]+)\s*[:.-]\s*(.*)$/i);
      const title = label?.[1]?.trim() || (lines.length > 1 ? first.replace(/[:.]$/, "") : `Scene ${index + 1}`);
      const script = label ? lines.slice(1).join(" ") || label[1] : lines.join(" ");
      return { id: crypto.randomUUID(), title: title.slice(0, 50) || `Scene ${index + 1}`, script, duration: 5, clipIn: 0, clipId: "", matchScore: null, segmentType: index === 0 ? "intro" : "main" };
    });
  }

  function scoreClip(scene, clip) {
    const words = (value) => value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((word) => word.length > 2);
    const sceneWords = new Set(words(`${scene.title} ${scene.script}`));
    return words(clip.name).reduce((score, word) => score + (sceneWords.has(word) ? 2 : 0), 0);
  }

  function buildScenes() {
    let generated = extractScenes(scriptEditor.value);
    if (!generated.length) {
      toast("Add a script first, then build your scenes.");
      scriptEditor.focus();
      return;
    }
    generated.forEach((scene, index) => {
      if (clips.length) {
        const ranked = clips.map((clip) => ({ clip, score: scoreClip(scene, clip) })).sort((a, b) => b.score - a.score);
        scene.clipId = ranked[0]?.clip.id || "";
        scene.duration = Math.min(sceneDurationCap(scene), Math.max(3, Math.min(12, Math.round(safeDuration(ranked[0]?.clip) / Math.max(generated.length, 1)) || 5)));
        if (ranked[0]?.score === 0) scene.clipId = clips[index % clips.length].id;
      }
    });
    if (editingPreset === "vanlife") applyVanlifePacing(generated);
    if (hasVoiceOvers() && !voiceOversLoading()) distributeSceneDurations(generated, sceneDurationLimit());
    else limitSceneDurations(generated);
    scenes = generated;
    currentSceneIndex = 0;
    renderScenes();
    $("#scriptStatus").textContent = `${scenes.length} scenes ready`;
    $("#scriptStatus").previousElementSibling.style.background = "#a9dd61";
    toast(`${scenes.length} scenes added to your timeline.`);
    $("#sceneCount").scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  function limitSceneDurations(sceneList, maxDuration = MAX_VIDEO_DURATION) {
    sceneList.forEach((scene) => {
      scene.duration = Math.min(sceneDurationCap(scene), Math.max(1, Number(scene.duration) || 5));
    });
    const total = sceneList.reduce((sum, scene) => sum + Number(scene.duration || 0), 0);
    if (total <= maxDuration) return;
    const scale = maxDuration / total;
    let remaining = maxDuration;
    sceneList.forEach((scene, index) => {
      const minimumForFollowingScenes = sceneList.length - index - 1;
      const scaled = Math.max(1, Math.floor((Number(scene.duration) || 5) * scale * 2) / 2);
      scene.duration = Math.min(scaled, Math.max(1, remaining - minimumForFollowingScenes));
      remaining -= scene.duration;
    });
  }

  function applyVanlifePacing(sceneList) {
    const scenicMoments = /\b(sunrise|sunset|mountain|landscape|lake|ocean|coast|view|destination|arrive|arrival|wide|horizon|waterfall|desert|forest)\b/i;
    const activeMoments = /\b(drive|driving|road|travel|hike|hiking|walk|walking|cook|cooking|setup|set up|build|building|pack|packing|explore|exploring|journey)\b/i;
    sceneList.forEach((scene) => {
      const description = `${scene.title} ${scene.script}`;
      scene.duration = scenicMoments.test(description) ? 5 : activeMoments.test(description) ? 3.5 : 4;
    });
  }

  function applyVanlifePreset() {
    aspectRatio = "16:9";
    frameRate = 24;
    editingPreset = "vanlife";
    fitMode = "blur";
    transitionDuration = 0.4;
    applyVanlifePacing(scenes);
    if (hasVoiceOvers() && !voiceOversLoading()) distributeSceneDurations(scenes, sceneDurationLimit());
    else limitSceneDurations(scenes);
    $("#aspectButton").innerHTML = '16:9 <span>⌄</span>';
    $("#frameRateSelect").value = "24";
    renderScenes();
    toast(scenes.length
      ? "Vanlife edit applied: 16:9, 24 fps, full-frame fit, story pacing, and soft dissolves."
      : "Vanlife preset ready: 16:9, 24 fps, full-frame fit, and soft dissolves. Build scenes to apply story pacing.");
  }

  function removeClip(id) {
    const index = clips.findIndex((clip) => clip.id === id);
    if (index < 0) return;
    const [clip] = clips.splice(index, 1);
    URL.revokeObjectURL(clip.url);
    scenes.forEach((scene) => {
      if (scene.clipId === id) {
        scene.clipId = "";
        scene.matchScore = null;
        scene.visualAttribution = null;
      }
    });
    renderClips();
    renderVoiceOver();
    renderScenes();
  }

  function addVideoFiles(fileList) {
    const files = Array.from(fileList || []).filter((file) => file.type.startsWith("video/"));
    if (!files.length) {
      toast("Choose a video file to add to your library.");
      return;
    }
    files.forEach((file) => {
      const clip = { id: crypto.randomUUID(), name: file.name, file, url: URL.createObjectURL(file), duration: 5 };
      clips.push(clip);
      const probe = document.createElement("video");
      probe.preload = "metadata";
      const metadataUrl = URL.createObjectURL(file);
      probe.onloadedmetadata = () => {
        clip.duration = Number.isFinite(probe.duration) ? probe.duration : 5;
        URL.revokeObjectURL(metadataUrl);
        renderClips();
        renderScenes();
      };
      probe.onerror = () => {
        URL.revokeObjectURL(metadataUrl);
        toast(`Could not read video metadata for ${file.name}.`);
      };
      probe.src = metadataUrl;
    });
    renderClips();
    renderScenes();
    toast(`${files.length} video${files.length === 1 ? "" : "s"} added.`);
  }

  function stopPlayback() {
    playbackToken++;
    isPlaying = false;
    sourceVideo.pause();
    stopVoiceOvers();
    $("#playButton").textContent = "▶";
    $("#playButton").setAttribute("aria-label", "Play preview");
    $(".playing-wave").classList.remove("active");
  }

  async function playScene(index, token, transitionFrom = null) {
    if (token !== playbackToken || !scenes.length) return;
    if (index >= scenes.length) {
      stopPlayback();
      currentSceneIndex = 0;
      updateCurrentScene();
      $("#previewTimecode").textContent = "00:00";
      return;
    }
    currentSceneIndex = index;
    const scene = scenes[index];
    updateCurrentScene();
    $("#previewSceneLabel").textContent = `SCENE ${String(index + 1).padStart(2, "0")}  ·  ${scene.title.toUpperCase()}`;
    const clip = clips.find((item) => item.id === scene.clipId);
    if (!clip) {
      toast(`Choose footage for scene ${index + 1} to preview the full story.`);
      stopPlayback();
      return;
    }
    if (clip.kind === "image") {
      sourceVideo.pause();
      sourceVideo.removeAttribute("src");
      sourceVideo.dataset.clipId = "";
      sourceVideo.load();
      try {
        if (hasVoiceOvers()) await playVoiceOverAt(scenes.slice(0, index).reduce((sum, item) => sum + Number(item.duration || 0), 0));
        drawCover(clip.image);
        startPreviewDrawing(transitionFrom);
        const duration = Number(scene.duration) || 5;
        const started = performance.now();
        const tick = () => {
          if (token !== playbackToken) return;
          const elapsed = (performance.now() - started) / 1000;
          $("#previewTimecode").textContent = formatTime(elapsed);
          if (elapsed >= duration) {
            const lastFrame = document.createElement("canvas");
            lastFrame.width = canvas.width;
            lastFrame.height = canvas.height;
            lastFrame.getContext("2d").drawImage(canvas, 0, 0);
            playScene(index + 1, token, lastFrame);
          } else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      } catch (error) {
        if (token === playbackToken) {
          stopPlayback();
          toast(`Unable to preview this scene: ${error.message || "playback failed"}`);
        }
      }
      return;
    }
    if (sourceVideo.dataset.clipId !== clip.id) {
      sourceVideo.src = clip.url;
      sourceVideo.dataset.clipId = clip.id;
      sourceVideo.load();
    }
    try {
      if (sourceVideo.readyState < 1) await new Promise((resolve, reject) => {
        sourceVideo.addEventListener("loadedmetadata", resolve, { once: true });
        sourceVideo.addEventListener("error", reject, { once: true });
      });
      const inPoint = Math.min(Number(scene.clipIn) || 0, Math.max(0, sourceVideo.duration - 0.1));
      await seekVideo(inPoint);
      sourceVideo.muted = true;
      await sourceVideo.play();
      if (hasVoiceOvers()) await playVoiceOverAt(scenes.slice(0, index).reduce((sum, item) => sum + Number(item.duration || 0), 0));
      startPreviewDrawing(transitionFrom);
      const duration = Number(scene.duration) || 5;
      const started = performance.now();
      const tick = () => {
        if (token !== playbackToken) return;
        const elapsed = (performance.now() - started) / 1000;
        $("#previewTimecode").textContent = formatTime(inPoint + elapsed);
        if (elapsed >= duration) {
          sourceVideo.pause();
          const lastFrame = document.createElement("canvas");
          lastFrame.width = canvas.width;
          lastFrame.height = canvas.height;
          lastFrame.getContext("2d").drawImage(canvas, 0, 0);
          playScene(index + 1, token, lastFrame);
        } else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch (error) {
      if (token === playbackToken) {
        stopPlayback();
        toast(`Unable to preview this clip: ${error.message || "video playback failed"}`);
      }
    }
  }

  async function togglePreview() {
    if (isPlaying) { stopPlayback(); return; }
    if (!scenes.length) { toast("Build your scenes to preview your story."); return; }
    if (!scenes.some((scene) => clips.some((clip) => clip.id === scene.clipId))) { toast("Add footage and match a clip to a scene first."); return; }
    isPlaying = true;
    const token = ++playbackToken;
    $("#playButton").textContent = "Ⅱ";
    $("#playButton").setAttribute("aria-label", "Pause preview");
    $(".playing-wave").classList.add("active");
    await playScene(currentSceneIndex, token);
  }

  function stopVoiceOvers() {
    voiceOverTracks.forEach((track) => track.audio.pause());
    voiceOverAudioContainer.querySelectorAll("[data-preview-voiceover]").forEach((button) => { button.textContent = "▶ Preview"; });
  }

  async function seekVoiceOver(track, seconds) {
    const target = Math.max(0, Math.min(Number(seconds) || 0, Math.max(0, track.duration - 0.05)));
    if (Math.abs(track.audio.currentTime - target) < 0.05) return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out while seeking "${track.file.name}".`));
      }, 10000);
      const cleanup = () => {
        clearTimeout(timeout);
        track.audio.removeEventListener("seeked", onSeeked);
        track.audio.removeEventListener("error", onError);
      };
      const onSeeked = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error(`Unable to seek in "${track.file.name}".`)); };
      track.audio.addEventListener("seeked", onSeeked, { once: true });
      track.audio.addEventListener("error", onError, { once: true });
      try { track.audio.currentTime = target; }
      catch (error) { cleanup(); reject(error); }
    });
  }

  async function playVoiceOverAt(seconds) {
    if (!hasVoiceOvers()) return;
    stopVoiceOvers();
    let offset = Math.max(0, Number(seconds) || 0);
    const trackIndex = voiceOverTracks.findIndex((track) => {
      if (track.loading || track.error) return false;
      if (offset < track.duration) return true;
      offset -= track.duration;
      return false;
    });
    if (trackIndex < 0) return;
    const track = voiceOverTracks[trackIndex];
    for (let index = trackIndex; index < voiceOverTracks.length; index++) {
      const current = voiceOverTracks[index];
      if (current.loading || current.error) continue;
      current.audio.volume = Number($("#voiceOverVolume").value);
      current.audio.muted = false;
      if (index === trackIndex) await seekVoiceOver(current, offset);
      else current.audio.currentTime = 0;
      current.audio.onended = () => {
        const next = voiceOverTracks.slice(index + 1).find((candidate) => !candidate.loading && !candidate.error);
        if (next && isPlaying) next.audio.play().catch((error) => toast(`Unable to play "${next.file.name}": ${error.message}`));
      };
    }
    if (audioContext?.state === "suspended") await audioContext.resume();
    await track.audio.play();
  }

  async function ensureAudioCapture() {
    if (!audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("Audio capture is not supported in this browser.");
      audioContext = new AudioContextClass();
      audioDestination = audioContext.createMediaStreamDestination();
    }
    voiceOverTracks.forEach(connectVoiceOverTrack);
    if (audioContext.state === "suspended") await audioContext.resume();
    return hasVoiceOvers() ? audioDestination.stream : null;
  }

  function connectVoiceOverTrack(track) {
    if (!audioContext || track.source || track.error) return;
    track.source = audioContext.createMediaElementSource(track.audio);
    track.source.connect(audioDestination);
    track.source.connect(audioContext.destination);
  }

  async function renderVideo() {
    if (voiceOversLoading()) {
      toast("Wait for the voice-over duration to finish loading before exporting.");
      return;
    }
    if (totalTime() > sceneDurationLimit()) {
      toast(hasVoiceOvers()
        ? "Scene timings exceed the voice-over length. Match the timeline to your narration before exporting."
        : "Videos can be up to 10 minutes without a voice-over. Shorten scenes before exporting.");
      return;
    }
    if (!scenes.length || !scenes.some((scene) => clips.some((clip) => clip.id === scene.clipId))) {
      toast("Add scenes and match footage or a photo to at least one scene before exporting.");
      return;
    }
    if (!window.MediaRecorder || !canvas.captureStream) {
      toast("Video export requires a recent version of Chrome, Edge, or Firefox.");
      return;
    }
    stopPlayback();
    const missing = scenes.findIndex((scene) => !clips.some((clip) => clip.id === scene.clipId));
    if (missing !== -1) {
      toast(`Match footage to scene ${missing + 1} before exporting.`);
      return;
    }
    const modal = $("#modalBackdrop");
    modal.hidden = false;
    $("#modalTitle").textContent = "Your video is rendering";
    $("#modalText").textContent = "Keep this tab open while Scene records your scenes into a video.";
    $("#renderProgress").style.width = "0%";
    $("#renderCaption").textContent = "Preparing your video…";
    $("#renderDownload").hidden = true;
    const token = ++renderToken;
    let stream;
    let recorder;
    const originalCanvasSize = { width: canvas.width, height: canvas.height };
    try {
      const audioStream = await ensureAudioCapture();
      if (aspectRatio === "9:16") { canvas.width = 1080; canvas.height = 1920; }
      else if (aspectRatio === "1:1") { canvas.width = 1080; canvas.height = 1080; }
      else { canvas.width = 1920; canvas.height = 1080; }
      stream = canvas.captureStream(frameRate);
      if (audioStream) audioStream.getAudioTracks().forEach((track) => stream.addTrack(track));
      const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      const chunks = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      const stopped = new Promise((resolve, reject) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
        recorder.onerror = (event) => reject(event.error || new Error("The video renderer stopped unexpectedly."));
      });
      recorder.start(250);
      isPlaying = true;
      if (hasVoiceOvers()) {
        await playVoiceOverAt(0);
      }
      $("#renderCaption").textContent = "Rendering scene 1…";
      let voiceOverOffset = 0;
      let previousSceneFrame = null;
      for (let index = 0; index < scenes.length; index++) {
        if (token !== renderToken) throw new Error("Rendering was cancelled.");
        const scene = scenes[index];
        const clip = clips.find((item) => item.id === scene.clipId);
        if (!clip) throw new Error(`Match footage or a photo to scene ${index + 1} before exporting.`);
        currentSceneIndex = index;
        $("#previewPlaceholder").hidden = true;
        $("#previewSceneLabel").textContent = `SCENE ${String(index + 1).padStart(2, "0")}  ·  ${scene.title.toUpperCase()}`;
        $("#renderCaption").textContent = `Rendering scene ${index + 1} of ${scenes.length}…`;
        let inPoint = 0;
        if (clip.kind === "image") {
          sourceVideo.pause();
          sourceVideo.removeAttribute("src");
          sourceVideo.dataset.clipId = "";
          sourceVideo.load();
          sourceVideo.muted = true;
          drawCover(clip.image);
        } else {
          if (sourceVideo.dataset.clipId !== clip.id) {
            sourceVideo.pause();
            sourceVideo.src = clip.url;
            sourceVideo.dataset.clipId = clip.id;
            sourceVideo.load();
            await new Promise((resolve, reject) => {
              sourceVideo.addEventListener("loadedmetadata", resolve, { once: true });
              sourceVideo.addEventListener("error", () => reject(new Error(`Unable to load ${clip.name}.`)), { once: true });
            });
          } else if (sourceVideo.readyState < 1) {
            await new Promise((resolve, reject) => {
              sourceVideo.addEventListener("loadedmetadata", resolve, { once: true });
              sourceVideo.addEventListener("error", () => reject(new Error(`Unable to load ${clip.name}.`)), { once: true });
            });
          }
          inPoint = Math.min(Number(scene.clipIn) || 0, Math.max(0, sourceVideo.duration - 0.1));
          await seekVideo(inPoint);
          sourceVideo.muted = true;
          await sourceVideo.play();
        }
        if (hasVoiceOvers()) await playVoiceOverAt(voiceOverOffset);
        const seconds = Number(scene.duration) || 5;
        await new Promise((resolve) => {
          const start = performance.now();
          let raf;
          const draw = () => {
            if (token !== renderToken) { cancelAnimationFrame(raf); resolve(); return; }
            drawCover(clip.kind === "image" ? clip.image : sourceVideo);
            const elapsed = (performance.now() - start) / 1000;
            if (previousSceneFrame && transitionDuration > 0) {
              const progress = Math.min(1, elapsed / transitionDuration);
              if (progress < 1) {
                ctx.save();
                ctx.globalAlpha = 1 - progress;
                ctx.drawImage(previousSceneFrame, 0, 0, canvas.width, canvas.height);
                ctx.restore();
              }
            }
            $("#previewTimecode").textContent = formatTime(inPoint + elapsed);
            $("#renderProgress").style.width = `${Math.min(99, ((index + elapsed / seconds) / scenes.length) * 100)}%`;
            if (elapsed >= seconds) { resolve(); return; }
            raf = requestAnimationFrame(draw);
          };
          draw();
        });
        voiceOverOffset += Number(scene.duration) || 5;
        sourceVideo.pause();
        previousSceneFrame = document.createElement("canvas");
        previousSceneFrame.width = canvas.width;
        previousSceneFrame.height = canvas.height;
        previousSceneFrame.getContext("2d").drawImage(canvas, 0, 0);
      }
      isPlaying = false;
      stopVoiceOvers();
      recorder.stop();
      const blob = await stopped;
      const url = URL.createObjectURL(blob);
      const download = $("#renderDownload");
      download.href = url;
      download.download = `${($("#projectNameLabel").textContent || "my-scene").trim().replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() || "my-scene"}.webm`;
      download.hidden = false;
      $("#modalTitle").textContent = "Your story is ready";
      $("#modalText").textContent = `Rendered ${scenes.length} scenes into a ${formatTime(totalTime())} WebM video.`;
      $("#renderProgress").style.width = "100%";
      $("#renderCaption").textContent = "Your video is ready to download.";
      download.click();
      toast("Your video is ready to download.");
    } catch (error) {
      if (recorder?.state === "recording") recorder.stop();
      isPlaying = false;
      $("#modalTitle").textContent = "We couldn’t render your video";
      $("#modalText").textContent = error.message || "An unexpected error occurred while rendering.";
      $("#renderCaption").textContent = "Please check your clips and try again.";
      toast(error.message || "Video rendering failed.");
    } finally {
      stopVoiceOvers();
      stream?.getTracks().forEach((track) => track.stop());
      canvas.width = originalCanvasSize.width;
      canvas.height = originalCanvasSize.height;
      if (sourceVideo.dataset.clipId === clips.find((clip) => clip.id === scenes[currentSceneIndex]?.clipId)?.id) drawCover(sourceVideo);
      updateCurrentScene();
      $("#playButton").textContent = "▶";
      $(".playing-wave").classList.remove("active");
      $("#previewPlaceholder").hidden = Boolean(clips.find((clip) => clip.id === scenes[currentSceneIndex]?.clipId));
    }
  }

  function downloadProject() {
    if (!scenes.length && !clips.length) {
      toast("Add footage or a script before downloading your project.");
      return;
    }
    const project = {
      app: "Scene Studio",
      version: 1,
      projectName: $("#projectNameLabel").textContent,
      createdAt: new Date().toISOString(),
      script: scriptEditor.value,
      aspectRatio,
      frameRate,
      editingPreset,
      fitMode,
      transitionDuration,
      scenes: scenes.map(({ id, title, script, duration, clipIn, clipId, matchScore, visualAttribution }) => ({
        id, title, script, duration, clipIn, matchScore,
        clip: clips.find((item) => item.id === clipId)?.name || null,
        visualAttribution: visualAttribution || null
      })),
      footage: clips.map((clip) => ({
        name: clip.name,
        duration: safeDuration(clip),
        type: clip.file?.type || (clip.kind === "image" ? "image" : "video"),
        size: clip.file?.size || clip.size || null,
        sourceUrl: clip.attribution?.sourceUrl || null,
        creator: clip.attribution?.creator || null,
        license: clip.attribution?.license || null,
        licenseUrl: clip.attribution?.licenseUrl || null
      })),
      voiceOvers: voiceOverTracks.map((track) => ({ name: track.file.name, duration: track.duration, type: track.file.type, size: track.file.size, volume: Number($("#voiceOverVolume").value) })),
      note: "The project file stores scene, edit, and visual attribution details, not the original media files."
    };
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${($("#projectNameLabel").textContent || "my-scene").replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() || "my-scene"}.json`;
    link.click();
    URL.revokeObjectURL(url);
    toast("Project file downloaded.");
  }

  function setAutoMatchStatus(message, state = "working") {
    const status = $("#autoMatchStatus");
    status.textContent = message;
    status.dataset.state = state;
  }

  function visualSourceMode() {
    return document.querySelector('input[name="visualSourceMode"]:checked')?.value || "external";
  }

  function updateVisualSourceMode() {
    const external = visualSourceMode() === "external";
    document.querySelectorAll(".visual-source-option").forEach((option) => {
      option.classList.toggle("selected", option.querySelector("input").checked);
    });
    $("#autoMatchButton").textContent = external ? "✳ Find visuals online" : "✳ Match my uploaded clips";
    $("#mediaProviderSettings").hidden = !external;
    $(".provider-credit-links").hidden = !external;
    setAutoMatchStatus(external
      ? "Upload narration to create timed scenes and search external footage and licensed photos. Speech recognition runs on this device."
      : "Upload videos to your library and narration. Scenes will be matched to your clips using narration and filenames; online sources will not be searched.");
    requestAutosave();
  }

  function matchScenesToLibrary(sceneList, libraryClips, scriptScenes) {
    const stopWords = commonsStopWords;
    const tokens = (text) => text.toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .map((word) => word.replace(/(?:ing|ed|es|s)$/i, ""))
      .filter((word) => word.length > 2 && !stopWords.has(word));
    const clipTokens = new Map(libraryClips.map((clip) => [clip.id, new Set(tokens(clip.name))]));
    const used = new Set();
    let fallbackCount = 0;
    let repeatedCount = 0;
    const shotPositions = [0.18, 0.62, 0.38, 0.79, 0.48, 0.27, 0.68];

    sceneList.forEach((scene, index) => {
      const scriptScene = scriptScenes.length
        ? scriptScenes[Math.min(scriptScenes.length - 1, Math.floor(index * scriptScenes.length / sceneList.length))]
        : null;
      const sceneTokens = new Set(tokens(`${scene.title} ${scene.script} ${scriptScene?.title || ""} ${scriptScene?.script || ""}`));
      const unused = libraryClips.filter((clip) => !used.has(clip.id));
      const candidates = unused.length ? unused : libraryClips;
      const ranked = candidates.map((clip, clipIndex) => {
        const names = clipTokens.get(clip.id);
        const score = [...sceneTokens].reduce((sum, token) => sum + (names.has(token) ? 1 : 0), 0);
        return { clip, clipIndex, score };
      }).sort((first, second) => second.score - first.score || first.clipIndex - second.clipIndex);
      const selected = ranked[0];
      if (!selected) throw new Error("No uploaded video clips are available to match.");
      if (selected.score === 0) fallbackCount++;
      if (used.has(selected.clip.id)) repeatedCount++;
      used.add(selected.clip.id);
      scene.clipId = selected.clip.id;
      const availableStart = Math.max(0, safeDuration(selected.clip) - Math.min(scene.duration, safeDuration(selected.clip)));
      scene.clipIn = availableStart * shotPositions[index % shotPositions.length];
      scene.visualAttribution = selected.clip.attribution || null;
    });

    return { fallbackCount, repeatedCount };
  }

  async function getAiPipeline(task, model, progressLabel) {
    if (!transformersModulePromise) {
      transformersModulePromise = import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2").catch((error) => {
        transformersModulePromise = null;
        throw new Error(`Could not load the local AI library. Check your internet connection and retry. ${error.message}`);
      });
    }
    const module = await transformersModulePromise;
    const key = `${task}:${model}`;
    if (!aiPipelines.has(key)) {
      const progressCallback = (progress) => {
        if (Number.isFinite(progress?.progress)) {
          setAutoMatchStatus(`${progressLabel} · downloading model ${Math.round(progress.progress)}%`);
        }
      };
      const createPipeline = (device) => module.pipeline(task, model, {
        device,
        dtype: "q8",
        progress_callback: progressCallback
      });
      const initialize = async () => {
        if (navigator.gpu) {
          try {
            return await createPipeline("webgpu");
          } catch (error) {
            console.warn(`${model} could not initialize with WebGPU; retrying with WebAssembly.`, error);
            setAutoMatchStatus(`${progressLabel} · switching to compatibility mode`);
          }
        }
        return createPipeline("wasm");
      };
      aiPipelines.set(key, initialize().catch((error) => {
        aiPipelines.delete(key);
        throw error;
      }));
    }
    return aiPipelines.get(key);
  }

  function transcriptToScenes(transcripts) {
    const segments = [];
    let voiceOffset = 0;
    const addScene = (text, start) => {
      const script = text.replace(/\s+/g, " ").trim();
      if (!script) return;
      const title = script.split(/\s+/).slice(0, 7).join(" ").replace(/[.!?]+$/, "");
      segments.push({ title: title.slice(0, 50), script, start: voiceOffset + start });
    };

    transcripts.forEach(({ track, result }) => {
      const chunks = Array.isArray(result.chunks) ? result.chunks : [];
      const timedWords = chunks.filter((chunk) =>
        chunk.text?.trim() && Array.isArray(chunk.timestamp) &&
        Number.isFinite(chunk.timestamp[0]) && Number.isFinite(chunk.timestamp[1])
      );
      if (timedWords.length) {
        let group = [];
        let groupStart = 0;
        let groupEnd = 0;
        const flush = () => {
          if (!group.length) return;
          addScene(group.map((word) => word.text).join(""), groupStart);
          group = [];
        };
        timedWords.forEach((word) => {
          if (!group.length) groupStart = word.timestamp[0];
          group.push(word);
          groupEnd = word.timestamp[1];
          const text = group.map((item) => item.text).join("").trim();
          if (/[.!?]["')\]]?$/.test(text) || group.length >= 22 || groupEnd - groupStart >= 12) flush();
        });
        flush();
      } else {
        const sentences = (result.text || "").match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((part) => part.trim()).filter(Boolean) || [];
        const totalWords = sentences.reduce((sum, sentence) => sum + sentence.split(/\s+/).length, 0);
        let cursor = 0;
        sentences.forEach((sentence) => {
          const words = sentence.split(/\s+/).length;
          const start = track.duration * cursor / Math.max(1, totalWords);
          cursor += words;
          addScene(sentence, start);
        });
      }
      voiceOffset += track.duration;
    });
    const narrationDuration = totalVoiceOverDuration();
    const usableSegments = segments
      .filter((segment) => segment.start < narrationDuration)
      .sort((first, second) => first.start - second.start);
    let previousStart = 0;
    return usableSegments.map((segment, index) => {
      const minimumStart = index === 0 ? 0 : previousStart + 0.1;
      const latestStart = Math.max(minimumStart, narrationDuration - 0.1 * (usableSegments.length - index - 1));
      const start = index === 0 ? 0 : Math.min(Math.max(segment.start, minimumStart), latestStart);
      const nextStart = usableSegments[index + 1]?.start ?? narrationDuration;
      const end = index === usableSegments.length - 1
        ? narrationDuration
        : Math.min(narrationDuration, Math.max(start + 0.1, nextStart));
      previousStart = start;
      return {
        id: crypto.randomUUID(),
        title: segment.title || `Scene ${index + 1}`,
        script: segment.script,
        duration: Math.max(0.1, end - start),
        clipIn: 0,
        clipId: "",
        matchScore: null,
        segmentType: index === 0 ? "intro" : "main"
      };
    });
  }

  function commonsText(value) {
    const element = document.createElement("div");
    element.innerHTML = value || "";
    return element.textContent.trim().replace(/\s+/g, " ");
  }

  function commonsLicense(metadata) {
    const license = commonsText(metadata?.LicenseShortName?.value || metadata?.UsageTerms?.value);
    if (!license || /non-commercial|no derivatives|\bNC\b|\bND\b/i.test(license)) return "";
    return /^(?:CC0|public domain|PD\b|CC BY(?:-SA)?(?:\s|$))/i.test(license) ? license : "";
  }

  function mediaSearchText(query) {
    return query.replace(/\s+/g, " ").trim().slice(0, 100);
  }

  function providerApiKey(input, provider) {
    const key = input.value.trim();
    if (!key) return "";
    if (/^(?:https?:)?\/\//i.test(key)) throw new Error(`${provider} key must be an API key, not a URL.`);
    return key;
  }

  async function searchPexelsVideos(query) {
    const apiKey = providerApiKey($("#pexelsApiKey"), "Pexels");
    if (!apiKey) return [];
    const url = new URL("https://api.pexels.com/videos/search");
    url.searchParams.set("query", mediaSearchText(query));
    url.searchParams.set("orientation", "landscape");
    url.searchParams.set("size", "medium");
    url.searchParams.set("per_page", "8");
    const response = await fetch(url, { headers: { Authorization: apiKey } });
    if (!response.ok) throw new Error(`Pexels search failed (${response.status}).`);
    const data = await response.json();
    return (data.videos || []).flatMap((video) => {
      const file = (video.video_files || [])
        .filter((item) => item.file_type === "video/mp4" && item.width >= 640 && item.width >= item.height)
        .sort((first, second) => Math.abs(first.width - 1280) - Math.abs(second.width - 1280))[0];
      if (!file?.link || !video.url) return [];
      return [{
        kind: "video",
        mediaType: "video",
        provider: "Pexels",
        title: `Pexels video ${video.id}`,
        mediaUrl: file.link,
        sourceUrl: video.url,
        creator: video.user?.name || "Pexels contributor",
        license: "Pexels License",
        licenseUrl: "https://www.pexels.com/license/",
        sourceId: `pexels:${video.id}`
      }];
    });
  }

  async function searchPixabayVideos(query) {
    const apiKey = providerApiKey($("#pixabayApiKey"), "Pixabay");
    if (!apiKey) return [];
    const url = new URL("https://pixabay.com/api/videos/");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("q", mediaSearchText(query));
    url.searchParams.set("safesearch", "true");
    url.searchParams.set("per_page", "8");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Pixabay search failed (${response.status}).`);
    const data = await response.json();
    return (data.hits || []).flatMap((video) => {
      const file = [video.videos?.medium, video.videos?.large]
        .filter((item) => item?.url && item.width >= 640 && item.width >= item.height)
        .sort((first, second) => Math.abs(first.width - 1280) - Math.abs(second.width - 1280))[0];
      if (!file?.url || !video.pageURL) return [];
      return [{
        kind: "video",
        mediaType: "video",
        provider: "Pixabay",
        title: video.tags || `Pixabay video ${video.id}`,
        mediaUrl: file.url,
        sourceUrl: video.pageURL,
        creator: video.user || "Pixabay contributor",
        license: "Pixabay Content License",
        licenseUrl: "https://pixabay.com/service/license-summary/",
        sourceId: `pixabay:${video.id}`
      }];
    });
  }

  async function searchCommonsPhotos(query) {
    const url = new URL("https://commons.wikimedia.org/w/api.php");
    const params = {
      action: "query",
      generator: "search",
      gsrsearch: `${mediaSearchText(query)} filetype:bitmap`,
      gsrnamespace: "6",
      gsrlimit: "12",
      prop: "imageinfo",
      iiprop: "url|extmetadata|mime",
      iiurlwidth: "1280",
      format: "json",
      origin: "*"
    };
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    let data;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Wikimedia Commons search failed (${response.status}).`);
      data = await response.json();
      if (data.error?.code !== "cirrussearch-too-busy-error") break;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
    }
    if (data.error) throw new Error(`Wikimedia Commons search failed: ${data.error.info || data.error.code}.`);
    const words = new Set(query.toLowerCase().split(/\s+/).filter((word) => word.length > 2));
    return Object.values(data.query?.pages || [])
      .map((page) => {
        const info = page.imageinfo?.[0];
        const metadata = info?.extmetadata || {};
        const license = commonsLicense(metadata);
        const mime = info?.mime || "";
        if (!info?.thumburl || !info.descriptionurl || !license || !/^image\/(?:jpeg|png|webp|avif)$/i.test(mime)) return null;
        const creator = commonsText(metadata.Artist?.value || metadata.Credit?.value);
        const title = commonsText(metadata.ImageDescription?.value || page.title.replace(/^File:/, ""));
        const searchable = `${page.title} ${title}`.toLowerCase();
        const score = [...words].reduce((sum, word) => sum + (searchable.includes(word) ? 1 : 0), 0);
        return {
          title: page.title.replace(/^File:/, ""),
          kind: "image",
          mediaType: "image",
          provider: "Wikimedia Commons",
          imageUrl: info.thumburl,
          sourceUrl: info.descriptionurl,
          creator,
          license,
          licenseUrl: metadata.LicenseUrl?.value || "",
          description: title,
          score,
          sourceId: `commons:${page.pageid}`
        };
      })
      .filter(Boolean)
      .sort((first, second) => second.score - first.score);
  }

  async function loadCommonsPhoto(photo) {
    const response = await fetch(photo.imageUrl);
    if (!response.ok) throw new Error(`Could not download photo "${photo.title}" (${response.status}).`);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/") || blob.size > 15 * 1024 * 1024) {
      throw new Error(`The photo "${photo.title}" is not a supported image or exceeds the 15 MB limit.`);
    }
    const imageUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.decoding = "async";
    image.src = imageUrl;
    try {
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight) throw new Error("The image has no readable dimensions.");
    } catch (error) {
      URL.revokeObjectURL(imageUrl);
      throw new Error(`Could not decode photo "${photo.title}": ${error.message}`);
    }
    return { image, imageUrl, blob, size: blob.size };
  }

  async function loadRemoteVideo(candidate) {
    const response = await fetch(candidate.mediaUrl);
    if (!response.ok) throw new Error(`Could not download the ${candidate.provider} video (${response.status}).`);
    const size = Number(response.headers.get("content-length")) || 0;
    if (size > 35 * 1024 * 1024) throw new Error("The online video exceeds the 35 MB download limit.");
    const blob = await response.blob();
    if (!blob.type.startsWith("video/") || blob.size > 35 * 1024 * 1024) {
      throw new Error("The online video is not a supported format or exceeds the 35 MB download limit.");
    }
    const videoUrl = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Timed out while reading online video metadata."));
        }, 15000);
        const cleanup = () => {
          clearTimeout(timeout);
          video.removeEventListener("loadedmetadata", onLoaded);
          video.removeEventListener("error", onError);
        };
        const onLoaded = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error("The online video could not be decoded by this browser.")); };
        video.addEventListener("loadedmetadata", onLoaded, { once: true });
        video.addEventListener("error", onError, { once: true });
        video.src = videoUrl;
        video.load();
      });
      if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("The online video has no readable duration.");
      return { videoUrl, blob, duration: video.duration, size: blob.size };
    } catch (error) {
      URL.revokeObjectURL(videoUrl);
      throw new Error(`${candidate.provider} video could not be used: ${error.message}`);
    } finally {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }

  async function matchNarrationToFootage() {
    const button = $("#autoMatchButton");
    if (button.disabled) return;
    const sourceMode = visualSourceMode();
    const localClips = clips.filter((clip) => !clip.onlineGenerated && clip.kind !== "image");
    button.disabled = true;
    $("#visualSourceOptions").disabled = true;
    const addedClips = [];
    const providerErrors = [];
    const assetErrors = [];
    let localMatchSummary = null;
    try {
      if (!hasVoiceOvers() || voiceOversLoading()) {
        throw new Error("Upload voice-over audio and wait for its duration to load first.");
      }
      const invalidTrack = voiceOverTracks.find((track) => track.error);
      if (invalidTrack) throw new Error(`Fix or remove "${invalidTrack.file.name}" before searching for visuals.`);
      if (sourceMode === "library" && !localClips.length) {
        throw new Error("Add at least one video to your library, then choose Match my uploaded clips.");
      }

      setAutoMatchStatus("Loading the local speech model. First use may download model files.", "working");
      const transcriber = await getAiPipeline(
        "automatic-speech-recognition",
        "Xenova/whisper-tiny",
        "Speech model"
      );
      const transcripts = [];
      for (let index = 0; index < voiceOverTracks.length; index++) {
        const track = voiceOverTracks[index];
        setAutoMatchStatus(`Transcribing voice-over ${index + 1} of ${voiceOverTracks.length} on this device…`, "working");
        const result = await transcriber(track.url, {
          return_timestamps: "word",
          chunk_length_s: 30,
          stride_length_s: 5
        });
        if (!result.text?.trim()) throw new Error(`No speech could be recognized in "${track.file.name}".`);
        transcripts.push({ track, result });
      }

      const generated = transcriptToScenes(transcripts);
      if (!generated.length) throw new Error("The audio was transcribed, but no scene text could be created.");
      distributeSceneDurations(generated, sceneDurationLimit());
      const scriptScenes = extractScenes(scriptEditor.value);
      if (sourceMode === "library") {
        localMatchSummary = matchScenesToLibrary(generated, localClips, scriptScenes);
      } else {
      const usedSources = new Set(clips.filter((clip) => !clip.onlineGenerated && clip.attribution?.sourceId).map((clip) => clip.attribution.sourceId));
      const usedCreators = new Set();
      let previousProvider = "";
      let previousCreator = "";
      let downloadedBytes = 0;
      for (let index = 0; index < generated.length; index++) {
        const scene = generated[index];
        const scriptScene = scriptScenes.length
          ? scriptScenes[Math.min(scriptScenes.length - 1, Math.floor(index * scriptScenes.length / generated.length))]
          : null;
        const searchWords = `${scene.script} ${scriptScene?.title || ""} ${scriptScene?.script || ""}`
          .replace(/[^\p{L}\p{N}\s-]/gu, " ")
          .split(/\s+/)
          .filter((word) => word.length > 2 && !commonsStopWords.has(word.toLowerCase()))
          .filter((word, wordIndex, words) => words.findIndex((other) =>
            other.toLowerCase().startsWith(word.toLowerCase().slice(0, 5)) ||
            word.toLowerCase().startsWith(other.toLowerCase().slice(0, 5))
          ) === wordIndex);
        const searchText = searchWords.slice(0, 4).join(" ");
        if (!searchText) throw new Error(`No searchable narration was available for scene ${index + 1}.`);
        setAutoMatchStatus(`Searching varied landscape footage for scene ${index + 1} of ${generated.length}…`, "working");
        const results = [];
        const searchProviders = async (query) => {
          const searches = await Promise.allSettled([
            searchPexelsVideos(query),
            searchPixabayVideos(query),
            searchCommonsPhotos(query)
          ]);
          ["Pexels", "Pixabay", "Wikimedia Commons"].forEach((provider, searchIndex) => {
            const search = searches[searchIndex];
            if (search.status === "fulfilled") results.push(...search.value);
            else providerErrors.push(`${provider}: ${search.reason?.message || "search failed"}`);
          });
        };
        await searchProviders(searchText);
        let candidates = results.filter((result) => !usedSources.has(result.sourceId));
        if (!candidates.length && searchWords.length > 2) {
          const shortQuery = searchWords.slice(0, 2).join(" ");
          setAutoMatchStatus(`Broadening the visual search for scene ${index + 1}…`, "working");
          await searchProviders(shortQuery);
          candidates = results.filter((result) => !usedSources.has(result.sourceId));
        }
        if (!candidates.length) {
          const queryErrors = providerErrors.length ? ` ${providerErrors.slice(-3).join(" ")}` : "";
          throw new Error(`No new visual source was found for scene ${index + 1} (“${scene.title}”).${queryErrors}`);
        }
        candidates.sort((first, second) => {
          const firstCreator = first.creator.toLowerCase();
          const secondCreator = second.creator.toLowerCase();
          const firstPenalty = (first.provider === previousProvider ? 2 : 0) + (firstCreator === previousCreator ? 3 : 0) + (usedCreators.has(firstCreator) ? 1 : 0);
          const secondPenalty = (second.provider === previousProvider ? 2 : 0) + (secondCreator === previousCreator ? 3 : 0) + (usedCreators.has(secondCreator) ? 1 : 0);
          return firstPenalty - secondPenalty;
        });
        let matchedClip = null;
        let lastAssetError = "";
        for (const candidate of candidates) {
          try {
            setAutoMatchStatus(`Loading a distinct ${candidate.kind === "video" ? "video" : "photo"} for scene ${index + 1} of ${generated.length}…`, "working");
            let media;
            if (candidate.kind === "video") {
              media = await loadRemoteVideo(candidate);
            } else {
              media = await loadCommonsPhoto(candidate);
            }
            if (downloadedBytes + media.size > 300 * 1024 * 1024) {
              if (candidate.kind === "image") URL.revokeObjectURL(media.imageUrl);
              else URL.revokeObjectURL(media.videoUrl);
              throw new Error("The visual download total exceeded the 300 MB per-project limit.");
            }
            downloadedBytes += media.size;
            matchedClip = {
              id: crypto.randomUUID(),
              kind: candidate.kind,
              name: candidate.title,
              url: candidate.kind === "video" ? media.videoUrl : media.imageUrl,
              image: media.image,
              duration: candidate.kind === "video" ? media.duration : scene.duration,
              size: media.size,
              blob: media.blob,
              attribution: candidate,
              onlineGenerated: true
            };
            break;
          } catch (error) {
            lastAssetError = error.message || "The visual could not be loaded.";
            assetErrors.push(lastAssetError);
          }
        }
        if (!matchedClip) {
          throw new Error(`No compatible visual could be loaded for scene ${index + 1} (“${scene.title}”). ${lastAssetError}`);
        }
        addedClips.push(matchedClip);
        usedSources.add(matchedClip.attribution.sourceId);
        previousProvider = matchedClip.attribution.provider;
        previousCreator = matchedClip.attribution.creator.toLowerCase();
        usedCreators.add(previousCreator);
        scene.clipId = matchedClip.id;
        const shotPositions = [0.18, 0.62, 0.38, 0.79, 0.48, 0.27, 0.68];
        const availableStart = Math.max(0, matchedClip.duration - Math.min(scene.duration, matchedClip.duration));
        scene.clipIn = matchedClip.kind === "video" ? availableStart * shotPositions[index % shotPositions.length] : 0;
        scene.visualAttribution = matchedClip.attribution;
      }
      }

      const oldGeneratedClips = clips.filter((clip) => clip.onlineGenerated);
      oldGeneratedClips.forEach((clip) => URL.revokeObjectURL(clip.url));
      clips.splice(0, clips.length, ...clips.filter((clip) => !clip.onlineGenerated), ...addedClips);
      scenes = generated;
      currentSceneIndex = 0;
      if (!scriptEditor.value.trim()) {
        scriptEditor.value = generated.map((scene) => scene.script).join("\n\n");
        updateScriptMeta("Transcribed from voice-over");
      }
      renderClips();
      renderScenes();
      $("#scriptStatus").textContent = `${scenes.length} narration scenes ready`;
      const providers = [...new Set(addedClips.map((clip) => clip.attribution.provider))].join(", ");
      const warning = providerErrors.length || assetErrors.length
        ? ` Some sources were unavailable; working alternatives were used. ${[...new Set([...providerErrors, ...assetErrors])].slice(0, 3).join(" ")}`
        : "";
      const completion = sourceMode === "library"
        ? `Matched ${scenes.length} narration scenes to ${localClips.length} uploaded video${localClips.length === 1 ? "" : "s"}.${localMatchSummary.fallbackCount ? ` Used library order for ${localMatchSummary.fallbackCount} scene${localMatchSummary.fallbackCount === 1 ? "" : "s"} because filenames had no matching terms.` : ""}${localMatchSummary.repeatedCount ? ` Reused clips for ${localMatchSummary.repeatedCount} scene${localMatchSummary.repeatedCount === 1 ? "" : "s"} after every uploaded clip had been used.` : ""} No external visual sources were searched.`
        : `Matched ${scenes.length} scenes with distinct landscape visuals from ${providers}. Imported video audio is muted; only narration is included. Sources and contributors are varied to reduce repetition. Review screen direction and the 180° continuity rule before export.${warning}`;
      setAutoMatchStatus(completion, "success");
      toast(`Matched ${scenes.length} narration scenes with distinct visuals.`);
      $("#sceneCount").scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    } catch (error) {
      addedClips.forEach((clip) => URL.revokeObjectURL(clip.url));
      setAutoMatchStatus(error.message || "Narration matching failed.", "error");
      toast(error.message || "Narration matching failed.");
    } finally {
      button.disabled = false;
      $("#visualSourceOptions").disabled = false;
    }
  }

  function loadLibrary(key, source, isReady) {
    if (isReady()) return Promise.resolve();
    if (libraryLoads[key]) return libraryLoads[key];
    libraryLoads[key] = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = source;
      script.async = true;
      script.onload = () => isReady() ? resolve() : reject(new Error(`The ${key} document reader did not initialize.`));
      script.onerror = () => reject(new Error(`Could not load the ${key} document reader. Check your internet connection and try again.`));
      document.head.appendChild(script);
    }).catch((error) => {
      delete libraryLoads[key];
      throw error;
    });
    return libraryLoads[key];
  }

  async function extractDocxText(file) {
    await loadLibrary("Word", "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.9.0/mammoth.browser.min.js", () => Boolean(window.mammoth));
    const result = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    if (result.messages?.some((message) => message.type === "error")) {
      console.warn("DOCX import warnings:", result.messages.filter((message) => message.type === "error"));
    }
    return result.value.replace(/\r/g, "").replace(/\n{2,}/g, "\n\n").replace(/(?<!\n)\n(?!\n)/g, "\n\n").trim();
  }

  async function extractPdfText(file) {
    await loadLibrary("PDF", "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js", () => Boolean(window.pdfjsLib));
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const document = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const y = item.transform?.[5] ?? 0;
        let line = lines.find((candidate) => Math.abs(candidate.y - y) < 3);
        if (!line) {
          line = { y, parts: [] };
          lines.push(line);
        }
        line.parts.push(item.str.trim());
      }
      lines.sort((first, second) => second.y - first.y);
      pages.push(lines.map((line) => line.parts.join(" ").replace(/\s+/g, " ").trim()).filter(Boolean).join("\n"));
      page.cleanup();
    }
    await document.destroy();
    return pages.join("\n\n").trim();
  }

  async function loadScriptFile(file) {
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase();
    const status = $("#scriptStatus");
    const statusDot = status.previousElementSibling;
    status.textContent = `Reading ${file.name}…`;
    status.title = file.name;
    statusDot.style.background = "#b6ef67";
    $("#scriptUploadButton").disabled = true;
    try {
      let text;
      if (extension === "docx" || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        text = await extractDocxText(file);
      } else if (extension === "pdf" || file.type === "application/pdf") {
        text = await extractPdfText(file);
      } else if (["txt", "md", "srt", "vtt"].includes(extension) || file.type.startsWith("text/")) {
        text = (await file.text()).replace(/^\uFEFF/, "");
      } else {
        throw new Error("Unsupported script format. Choose a DOCX, PDF, TXT, MD, SRT, or VTT file.");
      }
      if (!text.trim()) throw new Error("No selectable text was found in this file. Scanned PDFs need OCR before import.");
      scriptEditor.value = text;
      updateScriptMeta(`${extension.toUpperCase()} script loaded`);
      status.title = file.name;
      toast(`Loaded ${file.name}.`);
    } catch (error) {
      status.textContent = "Script import failed";
      status.title = error.message || file.name;
      statusDot.style.background = "#e7a19a";
      toast(error.message || `Could not read ${file.name}.`);
    } finally {
      $("#scriptUploadButton").disabled = false;
    }
  }

  function updateScriptMeta(statusText) {
    const words = scriptEditor.value.trim().split(/\s+/).filter(Boolean).length;
    $("#wordCount").textContent = `${words} word${words === 1 ? "" : "s"}`;
    $("#scriptStatus").textContent = statusText || (words ? "Script ready to build" : "Ready for your story");
    $("#scriptStatus").title = "";
    $("#scriptStatus").previousElementSibling.style.background = words ? "#a9dd61" : "#787b6f";
  }

  videoInput.addEventListener("change", () => { addVideoFiles(videoInput.files); videoInput.value = ""; });
  $("#addFootageButton").addEventListener("click", () => videoInput.click());
  $("#browseClipsButton").addEventListener("click", (event) => { event.stopPropagation(); videoInput.click(); });
  $("#uploadZone").addEventListener("click", (event) => { if (event.target.closest("button")) return; videoInput.click(); });
  $("#uploadZone").addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); videoInput.click(); } });
  $("#uploadZone").addEventListener("dragover", (event) => { event.preventDefault(); $("#uploadZone").classList.add("dragging"); });
  $("#uploadZone").addEventListener("dragleave", () => $("#uploadZone").classList.remove("dragging"));
  $("#uploadZone").addEventListener("drop", (event) => { event.preventDefault(); $("#uploadZone").classList.remove("dragging"); addVideoFiles(event.dataTransfer.files); });
  $("#scriptUploadButton").addEventListener("click", () => scriptFileInput.click());
  scriptFileInput.addEventListener("change", () => { loadScriptFile(scriptFileInput.files?.[0]); scriptFileInput.value = ""; });
  $("#voiceOverUploadButton").addEventListener("click", () => voiceOverInput.click());
  $("#browseVoiceOverButton").addEventListener("click", (event) => { event.stopPropagation(); voiceOverInput.click(); });
  $("#voiceOverDrop").addEventListener("click", (event) => { if (!event.target.closest("button")) voiceOverInput.click(); });
  $("#voiceOverDrop").addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); voiceOverInput.click(); } });
  $("#voiceOverDrop").addEventListener("dragover", (event) => { event.preventDefault(); $("#voiceOverDrop").classList.add("dragging"); });
  $("#voiceOverDrop").addEventListener("dragleave", () => $("#voiceOverDrop").classList.remove("dragging"));
  $("#voiceOverDrop").addEventListener("drop", (event) => { event.preventDefault(); $("#voiceOverDrop").classList.remove("dragging"); addVoiceOver(event.dataTransfer.files); });
  voiceOverInput.addEventListener("change", () => { addVoiceOver(voiceOverInput.files); voiceOverInput.value = ""; });
  $("#visualSourceOptions").addEventListener("change", updateVisualSourceMode);
  updateVisualSourceMode();
  $("#autoMatchButton").addEventListener("click", matchNarrationToFootage);
  voiceOverAudioContainer.addEventListener("click", async (event) => {
    const previewButton = event.target.closest("[data-preview-voiceover]");
    if (previewButton) {
      const track = voiceOverTracks.find((item) => item.id === previewButton.dataset.previewVoiceover);
      if (!track) return;
      if (track.audio.paused) {
        await previewVoiceOver(track.id);
      } else {
        track.audio.pause();
        previewButton.textContent = "▶ Preview";
      }
      return;
    }
    const removeButton = event.target.closest("[data-remove-voiceover]");
    if (removeButton) removeVoiceOver(removeButton.dataset.removeVoiceover);
  });
  $("#voiceOverVolume").addEventListener("input", () => {
    const volume = Number($("#voiceOverVolume").value);
    voiceOverTracks.forEach((track) => { track.audio.volume = volume; });
    $("#voiceOverVolumeLabel").textContent = `${Math.round(volume * 100)}%`;
    requestAutosave();
  });
  scriptEditor.addEventListener("input", () => {
    updateScriptMeta();
    requestAutosave();
  });
  $("#generateButton").addEventListener("click", buildScenes);
  $("#emptyBuildButton").addEventListener("click", buildScenes);
  $("#addSceneButton").addEventListener("click", () => {
    const remaining = sceneDurationLimit() - totalTime();
    if (!hasVoiceOvers() && remaining < 1) {
      toast("Your video has reached the 10-minute limit. Shorten a scene before adding another.");
      return;
    }
    const defaultDuration = editingPreset === "vanlife" ? 4 : 5;
    const scene = { id: crypto.randomUUID(), title: `Scene ${scenes.length + 1}`, script: "", duration: hasVoiceOvers() ? defaultDuration : Math.min(defaultDuration, remaining, MAIN_MAX_SCENE_DURATION), clipIn: 0, clipId: clips[0]?.id || "", segmentType: scenes.length ? "main" : "intro" };
    scenes.push(scene);
    if (hasVoiceOvers() && !voiceOversLoading()) distributeSceneDurations(scenes, sceneDurationLimit());
    currentSceneIndex = scenes.length - 1;
    renderScenes();
    const input = document.querySelector(`[data-scene-title="${scene.id}"]`);
    input?.focus();
    input?.select();
  });
  $("#playButton").addEventListener("click", togglePreview);
  $("#prevSceneButton").addEventListener("click", () => {
    if (!scenes.length) return;
    stopPlayback();
    currentSceneIndex = (currentSceneIndex - 1 + scenes.length) % scenes.length;
    updateCurrentScene();
  });
  $("#nextSceneButton").addEventListener("click", () => {
    if (!scenes.length) return;
    stopPlayback();
    currentSceneIndex = (currentSceneIndex + 1) % scenes.length;
    updateCurrentScene();
  });
  $("#exportButton").addEventListener("click", renderVideo);
  $("#downloadProjectButton").addEventListener("click", downloadProject);
  $("#modalClose").addEventListener("click", () => { renderToken++; $("#modalBackdrop").hidden = true; });
  $("#modalBackdrop").addEventListener("click", (event) => { if (event.target === $("#modalBackdrop")) { renderToken++; $("#modalBackdrop").hidden = true; } });
  $("#fullscreenButton").addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement) await $("#previewScreen").requestFullscreen();
      else await document.exitFullscreen();
    } catch { toast("Fullscreen is not available in this browser."); }
  });
  $("#aspectButton").addEventListener("click", () => {
    const options = ["16:9", "9:16", "1:1"];
    aspectRatio = options[(options.indexOf(aspectRatio) + 1) % options.length];
    editingPreset = "custom";
    $("#aspectButton").innerHTML = `${aspectRatio} <span>⌄</span>`;
    toast(`Export frame set to ${aspectRatio}.`);
    requestAutosave();
  });
  $("#frameRateSelect").addEventListener("change", () => {
    frameRate = Number($("#frameRateSelect").value);
    editingPreset = "custom";
    toast(`Export frame rate set to ${frameRate} fps.`);
    requestAutosave();
  });
  $("#vanlifePresetButton").addEventListener("click", applyVanlifePreset);
  $("#projectButton").addEventListener("click", () => {
    const name = prompt("Name your story:", $("#projectNameLabel").textContent);
    if (name?.trim()) {
      $("#projectNameLabel").textContent = name.trim();
      requestAutosave();
    }
  });
  $("#newProjectButton").addEventListener("click", () => {
    if (scenes.length || clips.length || hasVoiceOvers() || scriptEditor.value.trim()) {
      if (!confirm("Start a new project? This clears the current footage and script.")) return;
    }
    stopPlayback();
    clips.forEach((clip) => URL.revokeObjectURL(clip.url));
    clips.splice(0, clips.length);
    if (hasVoiceOvers()) {
      voiceOverTracks.splice(0, voiceOverTracks.length).forEach((track) => {
        track.audio.pause();
        track.source?.disconnect();
        track.audio.remove();
        URL.revokeObjectURL(track.url);
      });
      renderVoiceOver();
    }
    scenes = [];
    scriptEditor.value = "";
    $("#projectNameLabel").textContent = "Untitled story";
    updateScriptMeta();
    renderClips();
    renderScenes();
    clearAutosave().catch((error) => {
      console.error("Could not clear the local project save.", error);
      setSaveStatus("Unable to clear saved project", "error");
      toast(`Could not clear the saved project: ${error.message}`);
    });
    toast("New project ready.");
  });
  $("#helpButton").addEventListener("click", () => toast("Upload clips, add a script, build scenes, then preview and export."));
  $("#timelineMoreButton").addEventListener("click", () => toast("Tip: drag any library clip onto a scene to match it."));
  $("#previewMenu").addEventListener("click", () => toast("Preview uses your selected scene footage and script."));
  $("#aspectButton").title = "Cycle export aspect ratio";
  sourceVideo.addEventListener("timeupdate", () => {
    if (isPlaying) drawCover(sourceVideo);
  });

  updateScriptMeta();
  renderClips();
  renderScenes();
  restoreAutosave();
})();
