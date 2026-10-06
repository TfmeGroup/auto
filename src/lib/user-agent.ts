/**
 * Tiny, dependency-free User-Agent summariser for the "your devices" list and
 * new-sign-in alerts. Deliberately approximate: it is a label for people, never a
 * security decision.
 */
export interface DeviceInfo {
  browser: string;
  os: string;
  type: 'Mobile' | 'Tablet' | 'Desktop' | 'Unknown';
  label: string;
}

export function describeUserAgent(ua: string | null | undefined): DeviceInfo {
  if (!ua) return { browser: 'Unknown browser', os: 'Unknown device', type: 'Unknown', label: 'Unknown device' };

  const browser =
    /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /(CriOS|Chrome)\//.test(ua) ? 'Chrome'
    : /(FxiOS|Firefox)\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) && /Version\//.test(ua) ? 'Safari'
    : /curl|node|python|axios|okhttp/i.test(ua) ? 'API client'
    : 'Browser';

  const os =
    /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'Unknown OS';

  const type: DeviceInfo['type'] =
    /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'Tablet'
    : /Mobi|iPhone|Android/.test(ua) ? 'Mobile'
    : os === 'Unknown OS' ? 'Unknown'
    : 'Desktop';

  return { browser, os, type, label: `${browser} on ${os}` };
}
