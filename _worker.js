export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const canonicalHost = env.CANONICAL_HOST || '';

    if (canonicalHost && url.hostname === `www.${canonicalHost}`) {
      url.hostname = canonicalHost;
      return Response.redirect(url.toString(), 301);
    }

    return env.ASSETS.fetch(request);
  },
};
