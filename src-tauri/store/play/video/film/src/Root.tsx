import { Composition } from "remotion";
import { Film } from "./Film";
import { DURATION, FPS, HEIGHT, WIDTH } from "./scenes";

export const RemotionRoot: React.FC = () => (
  <Composition
    id="PlayPreview"
    component={Film}
    durationInFrames={DURATION}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
    defaultProps={{ useClips: true }}
  />
);
