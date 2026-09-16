const MUSIC_TRACK_KEY = 'moon_music_track';
const MUSIC_SHELF_KEY = 'moon_music_shelf';

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
        // The player still works when storage is unavailable.
    }
}

function initMusicShelf(shelf: HTMLDetailsElement): void {
    if (shelf.dataset.ready === 'true') return;

    const label = shelf.querySelector<HTMLElement>('[data-music-label]');
    const link = shelf.querySelector<HTMLAnchorElement>('[data-music-link]');
    const artistButtons = Array.from(shelf.querySelectorAll<HTMLButtonElement>('[data-music-artist]'));
    const trackGroups = Array.from(shelf.querySelectorAll<HTMLElement>('[data-music-track-group]'));
    const trackButtons = Array.from(shelf.querySelectorAll<HTMLButtonElement>('[data-music-track]'));
    const artistSelections = new Map<string, HTMLButtonElement>();

    if (!label || !link || artistButtons.length === 0 || trackButtons.length === 0) return;

    const activateTrack = (button: HTMLButtonElement): void => {
        const trackId = button.dataset.trackId;
        const title = button.dataset.trackTitle;
        const artist = button.dataset.trackArtist;
        const artistIndex = button.dataset.artistIndex;

        if (!trackId || !title || !artist || artistIndex === undefined) return;

        trackButtons.forEach((item) => {
            const active = item === button;
            item.classList.toggle('is-active', active);
            item.setAttribute('aria-pressed', String(active));
        });

        artistSelections.set(artistIndex, button);
        label.textContent = `${artist} · ${title}`;
        link.href = `https://open.spotify.com/track/${encodeURIComponent(trackId)}`;
        link.setAttribute('aria-label', `在 Spotify 打开 ${artist}《${title}》`);
        savePreference(MUSIC_TRACK_KEY, trackId);
    };

    const activateArtist = (button: HTMLButtonElement, preferredTrack?: HTMLButtonElement): void => {
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
        const selectedTrack = preferredTrack ?? artistSelections.get(artistIndex) ?? fallbackTrack;
        if (selectedTrack) activateTrack(selectedTrack);
    };

    artistButtons.forEach((button, index) => {
        button.addEventListener('click', () => activateArtist(button));
        button.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

            event.preventDefault();
            const direction = event.key === 'ArrowRight' ? 1 : -1;
            const nextIndex = (index + direction + artistButtons.length) % artistButtons.length;
            artistButtons[nextIndex].focus();
            activateArtist(artistButtons[nextIndex]);
        });
    });

    trackButtons.forEach((button) => {
        button.addEventListener('click', () => activateTrack(button));
        button.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

            event.preventDefault();
            const visibleTracks = trackButtons.filter((track) => !track.closest<HTMLElement>('[data-music-track-group]')?.hidden);
            const visibleIndex = visibleTracks.indexOf(button);
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            const nextIndex = (visibleIndex + direction + visibleTracks.length) % visibleTracks.length;
            visibleTracks[nextIndex].focus();
            activateTrack(visibleTracks[nextIndex]);
        });
    });

    const storedTrack = readPreference(MUSIC_TRACK_KEY);
    const storedButton = trackButtons.find((button) => button.dataset.trackId === storedTrack);
    const initialTrack = storedButton ?? trackButtons[0];
    const initialArtist = artistButtons.find((button) => button.dataset.artistIndex === initialTrack.dataset.artistIndex);
    if (initialArtist) activateArtist(initialArtist, initialTrack);

    const shelfState = readPreference(MUSIC_SHELF_KEY);
    if (shelfState === 'closed') shelf.open = false;

    shelf.addEventListener('toggle', () => {
        savePreference(MUSIC_SHELF_KEY, shelf.open ? 'open' : 'closed');
    });

    shelf.dataset.ready = 'true';
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll<HTMLDetailsElement>('[data-music-shelf]').forEach(initMusicShelf);
});
