const KEY = "lemma.token";

/**
 * The host hands the token over as `?token=` in the page URL. Keep it for this
 * tab only (sessionStorage) and strip it from the address bar and history.
 */
export const takeToken = (location: Location = window.location, history: History = window.history): string | undefined => {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl !== null) {
    try {
      sessionStorage.setItem(KEY, fromUrl);
    } catch {
      /* storage disabled: keep in memory only */
    }
    url.searchParams.delete("token");
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
    return fromUrl;
  }
  try {
    return sessionStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
};
