function hasOwnArtwork(media) {
  return Boolean(media) && Object.hasOwn(media, 'artwork');
}

function updateMediaState(previousMedia, previousArtwork, incomingMedia) {
  const trackChanged = previousMedia?.trackKey !== incomingMedia.trackKey;
  const artworkChanged = hasOwnArtwork(incomingMedia);
  const { artwork: incomingArtwork, ...metadata } = incomingMedia;
  const artwork = artworkChanged ? (incomingArtwork || null) : previousArtwork;
  const rendererPayload = artworkChanged
    ? { ...metadata, artwork }
    : metadata;

  return {
    artwork,
    artworkChanged,
    latestMedia: metadata,
    rendererPayload,
    trackChanged,
  };
}

function mediaForInitialization(media, artwork) {
  return media ? { ...media, artwork: artwork || null } : null;
}

module.exports = {
  hasOwnArtwork,
  mediaForInitialization,
  updateMediaState,
};
