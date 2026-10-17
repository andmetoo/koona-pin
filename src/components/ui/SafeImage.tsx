import type { ComponentProps } from "react";
import { usePublicImage } from "../../services/imageGuard";

/** An image whose external address passed the native DNS-aware network guard. */
export function SafeImage({ src, ...props }: ComponentProps<"img">) {
  const safe = usePublicImage(typeof src === "string" ? src : null);
  return safe ? <img {...props} src={safe} /> : null;
}
