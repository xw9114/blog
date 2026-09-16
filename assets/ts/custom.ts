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
    const buttons = Array.from(shelf.querySelectorAll<HTMLButtonElement>('[data-music-track]'));

    if (!label || !link || buttons.length === 0) return;

    const activateTrack = (button: HTMLButtonElement): void => {
        const trackId = button.dataset.trackId;
        const title = button.dataset.trackTitle;
        const artist = button.dataset.trackArtist;

        if (!trackId || !title || !artist) return;

        buttons.forEach((item) => {
            const active = item === button;
            item.classList.toggle('is-active', active);
            item.setAttribute('aria-pressed', String(active));
        });

        label.textContent = `${artist} · ${title}`;
        link.href = `https://open.spotify.com/track/${encodeURIComponent(trackId)}`;
        link.setAttribute('aria-label', `在 Spotify 打开 ${artist}《${title}》`);
        savePreference(MUSIC_TRACK_KEY, trackId);
    };

    buttons.forEach((button, index) => {
        button.addEventListener('click', () => activateTrack(button));
        button.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

            event.preventDefault();
            const direction = event.key === 'ArrowRight' ? 1 : -1;
            const nextIndex = (index + direction + buttons.length) % buttons.length;
            buttons[nextIndex].focus();
            activateTrack(buttons[nextIndex]);
        });
    });

    const storedTrack = readPreference(MUSIC_TRACK_KEY);
    const storedButton = buttons.find((button) => button.dataset.trackId === storedTrack);
    if (storedButton) activateTrack(storedButton);

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
