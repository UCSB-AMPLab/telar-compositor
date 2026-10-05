/**
 * useVideoAspect — the shape of the video the stage shows (`video-aspect.ts`).
 *
 * A YouTube video is probed through its thumbnail here; a Vimeo video's
 * aspect comes from its player, which calls `learn` once ready. What was
 * learned is kept with the video it was learned for, so a step that shows
 * another video never takes the last one's shape.
 *
 * @version v1.5.0-beta
 */

import { useCallback, useEffect, useState } from "react";
import { detectYouTubeAspect, videoAspectOf, type VideoAspect, type VideoProvider } from "~/lib/video-aspect";

export function useVideoAspect(provider: VideoProvider | null, videoId: string | null) {
  const [learned, setLearned] = useState<{ id: string; value: number | null } | null>(null);

  useEffect(() => {
    if (provider !== "youtube" || !videoId) return;
    let current = true;
    detectYouTubeAspect(videoId).then((value) => {
      if (current) setLearned({ id: videoId, value });
    });
    return () => {
      current = false;
    };
  }, [provider, videoId]);

  const learn = useCallback(
    (aspect: number) => {
      if (videoId) setLearned({ id: videoId, value: aspect });
    },
    [videoId],
  );

  const shape: VideoAspect | null = provider
    ? videoAspectOf(provider, learned && learned.id === videoId ? learned.value : undefined)
    : null;
  return { shape, learn };
}
