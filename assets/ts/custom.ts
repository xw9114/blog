const MUSIC_TRACK_KEY = 'moon_music_track';
const MUSIC_SHELF_KEY = 'moon_music_shelf';
const MUSIC_VOLUME_KEY = 'moon_music_volume';
const MUSIC_SHUFFLE_KEY = 'moon_music_shuffle';
const MUSIC_REPEAT_KEY = 'moon_music_repeat';
const MUSIC_POSITION_KEY = 'moon_music_position';

interface StoredPosition {
    trackId: string;
    time: number;
}

interface TrackActivationOptions {
    autoplay?: boolean;
    restorePosition?: boolean;
}

function readPreference(key: string): string | null {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function savePreference(key: string, value: string): void {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        // The player remains usable when storage is unavailable.
    }
}

function readStoredPosition(): StoredPosition | null {
    const stored = readPreference(MUSIC_POSITION_KEY);
    if (!stored) return null;

    try {
        const value = JSON.parse(stored) as { trackId?: unknown; time?: unknown };
        if (typeof value.trackId !== 'string' || typeof value.time !== 'number') return null;
        return { trackId: value.trackId, time: value.time };
    } catch {
        return null;
    }
}

function formatTime(value: number): string {
    if (!Number.isFinite(value) || value < 0) return '0:00';
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
}

function initMusicShelf(shelf: HTMLDetailsElement): void {
    if (shelf.dataset.ready === 'true') return;

    const audio = shelf.querySelector<HTMLAudioElement>('[data-music-audio]');
    const label = shelf.querySelector<HTMLElement>('[data-music-label]');
    const status = shelf.querySelector<HTMLElement>('[data-music-status]');
    const playButton = shelf.querySelector<HTMLButtonElement>('[data-music-play]');
    const previousButton = shelf.querySelector<HTMLButtonElement>('[data-music-previous]');
    const nextButton = shelf.querySelector<HTMLButtonElement>('[data-music-next]');
    const shuffleButton = shelf.querySelector<HTMLButtonElement>('[data-music-shuffle]');
    const repeatButton = shelf.querySelector<HTMLButtonElement>('[data-music-repeat]');
    const progress = shelf.querySelector<HTMLInputElement>('[data-music-progress]');
    const elapsed = shelf.querySelector<HTMLElement>('[data-music-elapsed]');
    const duration = shelf.querySelector<HTMLElement>('[data-music-duration]');
    const volume = shelf.querySelector<HTMLInputElement>('[data-music-volume]');
    const artistButtons = Array.from(shelf.querySelectorAll<HTMLButtonElement>('[data-music-artist]'));
    const trackGroups = Array.from(shelf.querySelectorAll<HTMLElement>('[data-music-track-group]'));
    const trackButtons = Array.from(shelf.querySelectorAll<HTMLButtonElement>('[data-music-track]'));
    const artistSelections = new Map<string, HTMLButtonElement>();

    if (!audio || !label || !status || !playButton || !previousButton || !nextButton ||
        !shuffleButton || !repeatButton || !progress || !elapsed || !duration || !volume ||
        artistButtons.length === 0 || trackButtons.length === 0) return;

    let selectedTrack: HTMLButtonElement = trackButtons[0];
    let pendingSeek: number | null = null;
    let shuffleEnabled = readPreference(MUSIC_SHUFFLE_KEY) === 'true';
    let repeatEnabled = readPreference(MUSIC_REPEAT_KEY) === 'true';
    let lastSavedSecond = -1;

    const storedVolumeValue = readPreference(MUSIC_VOLUME_KEY);
    const storedVolume = storedVolumeValue === null ? Number.NaN : Number(storedVolumeValue);
    audio.volume = Number.isFinite(storedVolume) && storedVolume >= 0 && storedVolume <= 1 ? storedVolume : 0.8;
    volume.value = String(audio.volume);
    audio.loop = repeatEnabled;
    shuffleButton.setAttribute('aria-pressed', String(shuffleEnabled));
    repeatButton.setAttribute('aria-pressed', String(repeatEnabled));
    shuffleButton.classList.toggle('is-active', shuffleEnabled);
    repeatButton.classList.toggle('is-active', repeatEnabled);

    const setStatus = (message: string, state: 'ready' | 'playing' | 'paused' | 'waiting' | 'error'): void => {
        status.textContent = message;
        status.dataset.state = state;
    };

    const fileName = (file?: string): string => {
        return file?.split('/').pop() || '对应的本地 MP3';
    };

    const setPlayingState = (playing: boolean): void => {
        shelf.classList.toggle('is-playing', playing);
        playButton.setAttribute('aria-label', playing ? '暂停' : '播放');
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    };

    const isAvailable = (button: HTMLButtonElement): boolean => {
        return button.dataset.trackAvailable === 'true' && Boolean(button.dataset.trackSrc);
    };

    const getVisibleTracks = (): HTMLButtonElement[] => {
        return trackButtons.filter((track) => !track.closest<HTMLElement>('[data-music-track-group]')?.hidden);
    };

    const savePosition = (): void => {
        const trackId = selectedTrack.dataset.trackId;
        if (!trackId || !Number.isFinite(audio.currentTime)) return;
        savePreference(MUSIC_POSITION_KEY, JSON.stringify({ trackId, time: audio.currentTime }));
    };

    const updateMediaSession = (title: string, artist: string): void => {
        if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
        navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album: '月栖之地' });
    };

    const activateTrack = (button: HTMLButtonElement, options: TrackActivationOptions = {}): void => {
        const trackId = button.dataset.trackId;
        const title = button.dataset.trackTitle;
        const artist = button.dataset.trackArtist;
        const artistIndex = button.dataset.artistIndex;
        const source = button.dataset.trackSrc;
        const file = button.dataset.trackFile;

        if (!trackId || !title || !artist || artistIndex === undefined) return;

        audio.pause();
        setPlayingState(false);
        selectedTrack = button;
        trackButtons.forEach((item) => {
            const active = item === button;
            item.classList.toggle('is-active', active);
            item.setAttribute('aria-pressed', String(active));
        });

        artistSelections.set(artistIndex, button);
        label.textContent = `${artist} · ${title}`;
        updateMediaSession(title, artist);
        savePreference(MUSIC_TRACK_KEY, trackId);
        elapsed.textContent = '0:00';
        duration.textContent = '0:00';
        progress.value = '0';

        if (!isAvailable(button) || !source) {
            audio.removeAttribute('src');
            audio.load();
            playButton.disabled = true;
            progress.disabled = true;
            pendingSeek = null;
            setStatus(`等待文件：${fileName(file)}`, 'waiting');
            return;
        }

        playButton.disabled = false;
        progress.disabled = false;
        pendingSeek = null;
        if (options.restorePosition) {
            const storedPosition = readStoredPosition();
            if (storedPosition?.trackId === trackId && storedPosition.time > 0) pendingSeek = storedPosition.time;
        }

        audio.src = source;
        audio.load();
        setStatus('准备播放', 'ready');
        if (options.autoplay) {
            audio.play().catch(() => setStatus('浏览器阻止了自动播放，请点击播放键', 'paused'));
        }
    };

    const activateArtist = (
        button: HTMLButtonElement,
        preferredTrack?: HTMLButtonElement,
        autoplay = false,
        restorePosition = false,
    ): void => {
        const artistIndex = button.dataset.artistIndex;
        if (artistIndex === undefined) return;

        artistButtons.forEach((item) => {
            const active = item === button;
            item.classList.toggle('is-active', active);
            item.setAttribute('aria-pressed', String(active));
        });
        trackGroups.forEach((group) => {
            group.hidden = group.dataset.artistIndex !== artistIndex;
        });

        const fallbackTrack = trackButtons.find((track) => track.dataset.artistIndex === artistIndex);
        const target = preferredTrack ?? artistSelections.get(artistIndex) ?? fallbackTrack;
        if (target) activateTrack(target, { autoplay, restorePosition });
    };

    const moveTrack = (direction: number, autoplay: boolean): void => {
        const visibleTracks = getVisibleTracks();
        const playableTracks = visibleTracks.filter(isAvailable);
        const candidates = playableTracks.length > 0 ? playableTracks : visibleTracks;
        if (candidates.length === 0) return;

        let nextTrack: HTMLButtonElement;
        if (shuffleEnabled && candidates.length > 1) {
            const alternatives = candidates.filter((track) => track !== selectedTrack);
            nextTrack = alternatives[Math.floor(Math.random() * alternatives.length)];
        } else {
            const foundIndex = candidates.indexOf(selectedTrack);
            const currentIndex = foundIndex >= 0 ? foundIndex : (direction > 0 ? -1 : 0);
            nextTrack = candidates[(currentIndex + direction + candidates.length) % candidates.length];
        }
        activateTrack(nextTrack, { autoplay });
    };

    artistButtons.forEach((button, index) => {
        button.addEventListener('click', () => activateArtist(button, undefined, !audio.paused));
        button.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const direction = event.key === 'ArrowRight' ? 1 : -1;
            const nextIndex = (index + direction + artistButtons.length) % artistButtons.length;
            artistButtons[nextIndex].focus();
            activateArtist(artistButtons[nextIndex], undefined, !audio.paused);
        });
    });

    trackButtons.forEach((button) => {
        button.addEventListener('click', () => activateTrack(button, { autoplay: !audio.paused && Boolean(audio.currentSrc) }));
        button.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            const visibleTracks = getVisibleTracks();
            const visibleIndex = visibleTracks.indexOf(button);
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            const nextIndex = (visibleIndex + direction + visibleTracks.length) % visibleTracks.length;
            visibleTracks[nextIndex].focus();
            activateTrack(visibleTracks[nextIndex]);
        });
    });

    playButton.addEventListener('click', () => {
        if (!isAvailable(selectedTrack)) {
            setStatus(`等待文件：${fileName(selectedTrack.dataset.trackFile)}`, 'waiting');
            return;
        }
        if (audio.paused) {
            audio.play().catch(() => setStatus('无法播放，请检查音频文件格式', 'error'));
        } else {
            audio.pause();
        }
    });

    previousButton.addEventListener('click', () => moveTrack(-1, !audio.paused));
    nextButton.addEventListener('click', () => moveTrack(1, !audio.paused));

    shuffleButton.addEventListener('click', () => {
        shuffleEnabled = !shuffleEnabled;
        shuffleButton.classList.toggle('is-active', shuffleEnabled);
        shuffleButton.setAttribute('aria-pressed', String(shuffleEnabled));
        savePreference(MUSIC_SHUFFLE_KEY, String(shuffleEnabled));
    });

    repeatButton.addEventListener('click', () => {
        repeatEnabled = !repeatEnabled;
        audio.loop = repeatEnabled;
        repeatButton.classList.toggle('is-active', repeatEnabled);
        repeatButton.setAttribute('aria-pressed', String(repeatEnabled));
        savePreference(MUSIC_REPEAT_KEY, String(repeatEnabled));
    });

    progress.addEventListener('input', () => {
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
        audio.currentTime = (Number(progress.value) / 1000) * audio.duration;
        elapsed.textContent = formatTime(audio.currentTime);
    });

    volume.addEventListener('input', () => {
        audio.volume = Number(volume.value);
        savePreference(MUSIC_VOLUME_KEY, volume.value);
    });

    audio.addEventListener('loadedmetadata', () => {
        duration.textContent = formatTime(audio.duration);
        if (pendingSeek !== null && pendingSeek < audio.duration) audio.currentTime = pendingSeek;
        pendingSeek = null;
    });

    audio.addEventListener('timeupdate', () => {
        elapsed.textContent = formatTime(audio.currentTime);
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
            progress.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
        }
        const currentSecond = Math.floor(audio.currentTime);
        if (currentSecond !== lastSavedSecond && currentSecond % 2 === 0) {
            lastSavedSecond = currentSecond;
            savePosition();
        }
    });

    audio.addEventListener('play', () => {
        setPlayingState(true);
        setStatus('正在播放', 'playing');
    });
    audio.addEventListener('pause', () => {
        setPlayingState(false);
        savePosition();
        if (!audio.ended && audio.currentTime > 0) setStatus('已暂停', 'paused');
    });
    audio.addEventListener('ended', () => {
        setPlayingState(false);
        if (!repeatEnabled) moveTrack(1, true);
    });
    audio.addEventListener('error', () => {
        setPlayingState(false);
        setStatus('音频加载失败，请检查文件是否完整', 'error');
    });

    if ('mediaSession' in navigator) {
        const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
            ['play', () => { void audio.play(); }],
            ['pause', () => audio.pause()],
            ['previoustrack', () => moveTrack(-1, true)],
            ['nexttrack', () => moveTrack(1, true)],
        ];
        handlers.forEach(([action, handler]) => {
            try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Unsupported action. */ }
        });
    }

    const storedTrack = readPreference(MUSIC_TRACK_KEY);
    const storedButton = trackButtons.find((button) => button.dataset.trackId === storedTrack);
    const initialTrack = storedButton ?? trackButtons[0];
    const initialArtist = artistButtons.find((button) => button.dataset.artistIndex === initialTrack.dataset.artistIndex);
    if (initialArtist) activateArtist(initialArtist, initialTrack, false, true);

    const shelfState = readPreference(MUSIC_SHELF_KEY);
    if (shelfState === 'closed') shelf.open = false;
    shelf.addEventListener('toggle', () => {
        savePreference(MUSIC_SHELF_KEY, shelf.open ? 'open' : 'closed');
    });
    window.addEventListener('pagehide', savePosition);
    shelf.dataset.ready = 'true';
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll<HTMLDetailsElement>('[data-music-shelf]').forEach(initMusicShelf);
});
