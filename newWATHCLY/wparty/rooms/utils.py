import re
from urllib.parse import urlparse, parse_qs


def parse_video_url(url):
    """
    Parses VK Video, RuTube or YouTube URL and returns embed URL.
    Returns dict: {'platform': 'vk'|'rutube'|'youtube', 'embed_url': str} or None.
    """
    if not url:
        return None

    url = url.strip()

    # --- VK Video ---
    # https://vk.com/video-12345_67890
    # https://vkvideo.ru/video-12345_67890
    vk_pattern = re.compile(
        r'(?:vk\.com|vkvideo\.ru)/(?:video|clip)(-?\d+)_(\d+)',
        re.IGNORECASE
    )
    m = vk_pattern.search(url)
    if m:
        oid = m.group(1)
        vid = m.group(2)
        embed_url = f'https://vkvideo.ru/video_ext.php?oid={oid}&id={vid}&hd=2&js_api=1'
        return {'platform': 'vk', 'embed_url': embed_url}

    # --- RuTube ---
    # https://rutube.ru/video/HASH/
    # https://rutube.ru/play/embed/HASH/
    rutube_pattern = re.compile(
        r'rutube\.ru/(?:video|play/embed)/([a-zA-Z0-9]+)',
        re.IGNORECASE
    )
    m = rutube_pattern.search(url)
    if m:
        video_id = m.group(1)
        # ?p=<placeholder> чтобы embed-URL гарантированно имел query-string,
        # а postMessage-команды плеера работали корректно.
        embed_url = f'https://rutube.ru/play/embed/{video_id}/?p=watchly'
        return {'platform': 'rutube', 'embed_url': embed_url}

    # --- YouTube ---
    # https://www.youtube.com/watch?v=VIDEOID
    # https://youtu.be/VIDEOID
    # https://www.youtube.com/shorts/VIDEOID
    # https://www.youtube.com/live/VIDEOID
    youtube_pattern = re.compile(
        r'(?:youtube\.com/(?:watch\?.*v=|shorts/|live/)|youtu\.be/)([a-zA-Z0-9_-]{11})',
        re.IGNORECASE
    )
    m = youtube_pattern.search(url)
    if m:
        video_id = m.group(1)
        # YT IFrame API создаёт плеер сам через JS — embed_url содержит только video_id
        embed_url = f'https://www.youtube.com/embed/{video_id}'
        return {'platform': 'youtube', 'embed_url': embed_url}

    return None
