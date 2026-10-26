import { loadFont } from "@remotion/google-fonts/Inter";
import { useEffect, useState } from "react";
import {
  AbsoluteFill,
  cancelRender,
  continueRender,
  delayRender,
  Easing,
  Freeze,
  Img,
  interpolate,
  OffthreadVideo,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { colours, FPS, HEIGHT, OVERLAP, sampleCards, type Scene, scenes, WIDTH } from "./scenes";

const { fontFamily, waitUntilDone } = loadFont("normal", { weights: ["400", "600", "700"], subsets: ["latin"] });

/** Frame zero waits for Inter; a render without it stops instead of falling back (MOTION.md §7). */
const useBrandFont = () => {
  const [handle] = useState(() => delayRender("Loading Inter"));
  useEffect(() => {
    waitUntilDone()
      .then(() => {
        if (!document.fonts.check(`600 68px ${fontFamily}`)) throw new Error("not available after loading");
        continueRender(handle);
      })
      .catch((error: unknown) => cancelRender(new Error(`The font Inter (400, 600, 700) could not be loaded: ${String(error)}`)));
  }, [handle]);
};

// The app's own curve (MOTION.md §5): soft entrances, no overshoot.
const soft = Easing.bezier(0.2, 0, 0, 1);
const ease = (frame: number, from: number, to: number, start: number, length: number) =>
  interpolate(frame, [start, start + length], [from, to], { easing: soft, extrapolateLeft: "clamp", extrapolateRight: "clamp" });

export type FilmProps = {
  /** Off until the clips are recorded (../scenario.md): the phone then shows the scene's name. */
  useClips: boolean;
};

// The phone screen: a 1080 × 2160 recording at a fixed height, the app's corner radius, in a phone of no make.
const PHONE_H = 860;
const PHONE_W = PHONE_H / 2;
/** The body's edge around the screen. */
const BEZEL = 14;
// The sync scene: the phone left of centre, the computer right of it, the caption under both.
const SYNC_PHONE_X = WIDTH / 2 - 470;
const SYNC_Y = HEIGHT / 2 - 100;
const SYNC_SCALE = 0.78;
const DESKTOP_W = 860;
const DESKTOP_X = WIDTH / 2 - 100;
// Placed from the canvas centre (MOTION.md §3): the phone right of centre, the caption left of it.
const PHONE_X = WIDTH / 2 + 260;
const CAPTION_X = WIDTH / 2 - 820;

const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  // A slow drift so holds are never frozen (MOTION.md §4).
  const shift = interpolate(frame, [0, durationInFrames], [0, 8]);
  return (
    <AbsoluteFill
      style={{
        // Warm paper to the app's green, with the accent glowing behind the phone: not a pale page.
        background: [
          `radial-gradient(circle at ${66 - shift / 2}% ${52 + shift / 3}%, rgba(47,107,79,0.32) 0%, rgba(47,107,79,0) 34%)`,
          `linear-gradient(${120 + shift}deg, #f1dcc6 0%, #f4ece1 42%, #d5e7da 100%)`,
        ].join(", "),
      }}
    />
  );
};

const Caption: React.FC<{ text: string; sub?: string; align?: "left" | "center"; top?: number }> = ({ text, sub, align = "left", top }) => {
  const frame = useCurrentFrame();
  const centred = align === "center";
  const line = (delay: number) => ({
    opacity: ease(frame, 0, 1, delay, 14),
    transform: `translateY(${ease(frame, 24, 0, delay, 18)}px)`,
  });
  return (
    <div
      style={{
        position: "absolute",
        left: centred ? 0 : CAPTION_X,
        width: centred ? WIDTH : 760,
        top: top ?? (centred ? HEIGHT - 300 : HEIGHT / 2 - 90),
        textAlign: align,
        fontFamily,
        color: colours.ink,
      }}
    >
      <div
        style={{
          width: 64,
          height: 8,
          borderRadius: 4,
          background: colours.accent,
          margin: centred ? "0 auto 26px" : "0 0 26px",
          ...line(0),
        }}
      />
      <div style={{ fontSize: 72, fontWeight: 700, lineHeight: 1.12, letterSpacing: -1.5, ...line(4) }}>{text}</div>
      {sub ? <div style={{ marginTop: 18, fontSize: 40, fontWeight: 400, color: colours.muted, ...line(8) }}>{sub}</div> : null}
    </div>
  );
};

/** A card of the sample library, as the library list draws one. */
const Card: React.FC<{ title: string; site: string }> = ({ title, site }) => (
  <div
    style={{
      width: 420,
      padding: "26px 30px",
      borderRadius: 28,
      background: "#fff",
      boxShadow: "0 18px 40px rgba(46,48,43,0.12)",
      fontFamily,
      color: colours.ink,
    }}
  >
    <div style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.2 }}>{title}</div>
    <div style={{ marginTop: 10, fontSize: 22, color: colours.muted }}>{site}</div>
  </div>
);

/** 0:00–0:02: the cards drift in from every edge and pile up, slightly too many. */
const Attention: React.FC<{ scene: Scene }> = ({ scene }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      {sampleCards.map((card, i) => {
        const angle = (i / sampleCards.length) * Math.PI * 2;
        // One at a time: each card lands before the next one starts (MOTION.md §6).
        const start = i * 8;
        const t = ease(frame, 0, 1, start, 18);
        const x = WIDTH / 2 - 210 + Math.cos(angle) * (1200 * (1 - t) + 140 + (i % 3) * 40);
        const y = HEIGHT / 2 - 60 + Math.sin(angle) * (800 * (1 - t) + 90 + (i % 2) * 50);
        return (
          <div key={card.title} style={{ position: "absolute", left: x, top: y, transform: `rotate(${(i % 2 ? 1 : -1) * (2 + i)}deg)`, opacity: t }}>
            <Card {...card} />
          </div>
        );
      })}
      <Caption text={scene.caption} align="center" />
    </AbsoluteFill>
  );
};

/** 0:02–0:04: the pile scatters into small grey chips of where links end up, and blurs. */
const Problem: React.FC<{ scene: Scene }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const places = ["chat", "notes", "open tab", "screenshot", "email to self", "open tab", "chat", "notes"];
  const blur = ease(frame, 0, 6, 40, 60);
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ filter: `blur(${blur}px)` }}>
        {places.map((place, i) => {
          const angle = (i / places.length) * Math.PI * 2 + 0.4;
          const t = ease(frame, 0, 1, i * 3, 40);
          const x = WIDTH / 2 + Math.cos(angle) * 620 * t - 90;
          const y = HEIGHT / 2 - 80 + Math.sin(angle) * 330 * t;
          return (
            <div
              key={`${place}-${i}`}
              style={{
                position: "absolute",
                left: x,
                top: y,
                padding: "14px 26px",
                borderRadius: 999,
                background: "#e8e7e2",
                color: colours.muted,
                fontFamily,
                fontSize: 30,
              }}
            >
              {place}
            </div>
          );
        })}
      </AbsoluteFill>
      <Caption text={scene.caption} align="center" />
    </AbsoluteFill>
  );
};

/** The phone screen of one recorded scene, or its name until the clips exist. */
const Screen: React.FC<{ scene: Scene; useClips: boolean; still?: number }> = ({ scene, useClips, still }) => {
  if (!useClips || !scene.clip) {
    return (
      <AbsoluteFill style={{ background: colours.accentSoft, alignItems: "center", justifyContent: "center", fontFamily, fontSize: 34, color: colours.accent }}>
        clip: {scene.clip}
      </AbsoluteFill>
    );
  }
  const take = (at: number) => <OffthreadVideo src={staticFile(`clips/${scene.clip}.mp4`)} trimBefore={Math.round(at * FPS)} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />;
  // Pieces of the take one after the other (a jump cut), or the take from its in-point.
  const pieces: [number, number][] = scene.segments ?? [[scene.clipFrom ?? 0, scene.clipLength ?? Infinity]];
  if (still !== undefined) return <Freeze frame={still}>{take(pieces[0][0])}</Freeze>;
  let at = 0;
  const parts = pieces.map(([from, to]) => {
    // A piece plays to its end or to the scene's; the scene holds the last frame after the last piece.
    const length = Math.max(1, Math.min(Math.floor((to - from) * FPS) - 1, scene.length - at));
    const part = { from, start: at, length };
    at += length;
    return part;
  });
  const last = parts[parts.length - 1];
  return (
    <>
      {parts.map((p) => (
        <Sequence key={p.start} from={p.start} durationInFrames={p.length} layout="none">
          {take(p.from)}
        </Sequence>
      ))}
      {at < scene.length ? (
        <Sequence from={at} layout="none">
          <Freeze frame={last.length - 1}>{take(last.from)}</Freeze>
        </Sequence>
      ) : null}
    </>
  );
};

/** Android's bars over the page's insets (the preview has none): the clock, Wi-Fi and battery; the gesture handle. */
const SystemBars: React.FC = () => {
  const bar = (PHONE_H * 34) / 786;
  return (
    <>
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: bar, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 22px", fontFamily, fontSize: 15, fontWeight: 600, color: colours.ink, zIndex: 2 }}>
        <span>9:41</span>
        <svg width="44" height="14" viewBox="0 0 44 14" fill={colours.ink}>
          <path d="M8 13 0 4.5a11.5 11.5 0 0 1 16 0z" />
          <rect x="22" y="2" width="19" height="10" rx="2.5" />
          <rect x="41.5" y="5" width="2" height="4" rx="1" />
        </svg>
      </div>
      <div style={{ position: "absolute", bottom: 7, left: PHONE_W / 2 - 50, width: 100, height: 4, borderRadius: 2, background: colours.ink, opacity: 0.55, zIndex: 2 }} />
    </>
  );
};

/** 0:04–0:27 and the payoff: the phone is one parent; its screens cross-fade under it. */
const PhoneStage: React.FC<{ useClips: boolean; start: number; besideAt: number; payoffAt: number }> = ({ useClips, start, besideAt, payoffAt }) => {
  const frame = useCurrentFrame();
  const recorded = scenes.filter((scene) => scene.clip);
  const nextJoined = (scene: Scene) => recorded[recorded.indexOf(scene) + 1]?.joined === true;
  // Sync: the phone moves left and steps back to make room for the computer beside it.
  const aside = ease(frame, 0, 1, besideAt - start - 6, 36);
  const enter = spring({ frame, fps: 60, config: { damping: 200 }, durationInFrames: 36 });
  // The payoff: the phone settles smaller at the centre, above the name.
  const settle = ease(frame, 0, 1, payoffAt - start, 36);
  const x = interpolate(settle, [0, 1], [interpolate(aside, [0, 1], [PHONE_X, SYNC_PHONE_X]), WIDTH / 2]);
  const y = interpolate(settle, [0, 1], [interpolate(aside, [0, 1], [HEIGHT / 2, SYNC_Y]), HEIGHT / 2 - 190]);
  const scale = interpolate(settle, [0, 1], [interpolate(aside, [0, 1], [1, SYNC_SCALE]), 0.5]) * interpolate(enter, [0, 1], [0.9, 1]);
  // A gentle push-in over the holds (MOTION.md §4).
  const drift = interpolate(frame, [0, payoffAt - start], [1, 1.02], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      {/* A phone of no make (MOTION.md §3): a dark body, a thin bezel, a punch-hole camera, two side keys. */}
      <div
        style={{
          position: "absolute",
          left: x - PHONE_W / 2 - BEZEL,
          top: y - PHONE_H / 2 - BEZEL + interpolate(enter, [0, 1], [80, 0]),
          padding: BEZEL,
          borderRadius: 44 + BEZEL,
          background: "linear-gradient(145deg, #3a3c36 0%, #1b1c19 45%, #121310 100%)",
          boxShadow: "0 50px 110px rgba(30,40,32,0.35), 0 0 0 1.5px #4a4c45, inset 0 0 0 1px rgba(255,255,255,0.06)",
          opacity: enter,
          transform: `scale(${scale * drift})`,
        }}
      >
        {[{ top: 170, height: 90 }, { top: 290, height: 56 }].map((key) => (
          <div key={key.top} style={{ position: "absolute", right: -4, top: key.top, width: 4, height: key.height, borderRadius: "0 3px 3px 0", background: "#2c2e29" }} />
        ))}
      <div
        style={{
          position: "relative",
          width: PHONE_W,
          height: PHONE_H,
          borderRadius: 44,
          overflow: "hidden",
          background: colours.paper,
        }}
      >
        <div style={{ position: "absolute", top: 9, left: PHONE_W / 2 - 7, width: 14, height: 14, borderRadius: 7, background: "#111", zIndex: 2 }} />
        {recorded.map((scene) => (
          <Sequence key={scene.id} from={scene.from - start} durationInFrames={scene.length} layout="none">
            <Fade length={scene.length} fadeIn={!scene.joined} fadeOut={!nextJoined(scene)}>
              <Screen scene={scene} useClips={useClips} />
            </Fade>
          </Sequence>
        ))}
        {/* The library, still, under the payoff. */}
        <Sequence from={payoffAt - start} layout="none">
          <Screen scene={recorded.find((scene) => scene.poster) ?? recorded[0]} useClips={useClips} still={0} />
        </Sequence>
        <SystemBars />
      </div>
      </div>
    </AbsoluteFill>
  );
};

/** Fades a child in and out over the scene overlap. */
const Fade: React.FC<{ length: number; fadeIn?: boolean; fadeOut?: boolean; children: React.ReactNode }> = ({ length, fadeIn = true, fadeOut = true, children }) => {
  const frame = useCurrentFrame();
  const opacity = Math.min(
    fadeIn ? interpolate(frame, [0, OVERLAP], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1,
    fadeOut ? interpolate(frame, [length - OVERLAP, length], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1,
  );
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

/** A padlock, drawn: the link between the devices is end-to-end encrypted. */
const Lock: React.FC = () => (
  <svg width="30" height="34" viewBox="0 0 30 34" fill="none">
    <path d="M8 15V10a7 7 0 0 1 14 0v5" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" />
    <rect x="3" y="14" width="24" height="18" rx="5" fill="#fff" />
  </svg>
);

/**
 * Sync (paid, Supporter): the phone beside a computer of the desktop app, with its Sync dialog (the
 * site's shot), and an encrypted link between them that passes changes and keeps nothing.
 */
const Sync: React.FC<{ scene: Scene }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const enter = ease(frame, 0, 1, 18, 30);
  const desktopH = (DESKTOP_W * 800) / 1280;
  const phoneRight = SYNC_PHONE_X + ((PHONE_W + 2 * BEZEL) * SYNC_SCALE) / 2;
  const linkFrom = phoneRight + 18;
  const linkTo = DESKTOP_X - 18;
  const linkY = SYNC_Y;
  const link = ease(frame, 0, 1, 40, 24);
  return (
    <AbsoluteFill>
      <Img
        src={staticFile("desktop-sync.webp")}
        style={{
          position: "absolute",
          left: DESKTOP_X,
          top: SYNC_Y - desktopH / 2 + interpolate(enter, [0, 1], [40, 0]),
          width: DESKTOP_W,
          height: desktopH,
          borderRadius: 18,
          boxShadow: "0 40px 100px rgba(30,40,32,0.30), 0 0 0 1px rgba(46,48,43,0.12)",
          opacity: enter,
        }}
      />
      {/* The link: a dashed line, changes travelling both ways, the padlock in the middle. */}
      <div style={{ position: "absolute", left: linkFrom, top: linkY - 2, width: (linkTo - linkFrom) * link, height: 4, backgroundImage: `repeating-linear-gradient(90deg, ${colours.accent} 0 10px, transparent 10px 18px)`, opacity: 0.8 }} />
      {[0, 1, 2].map((i) => {
        const t = ((frame - 60 + i * 22) % 66) / 66;
        const forward = i % 2 === 0;
        const at = forward ? t : 1 - t;
        return frame > 60 ? (
          <div key={i} style={{ position: "absolute", left: linkFrom + (linkTo - linkFrom) * at - 7, top: linkY - 7, width: 14, height: 14, borderRadius: 7, background: colours.accent, boxShadow: "0 0 14px rgba(47,107,79,0.6)" }} />
        ) : null;
      })}
      <div
        style={{
          position: "absolute",
          left: (linkFrom + linkTo) / 2 - 32,
          top: linkY - 32,
          width: 64,
          height: 64,
          borderRadius: 32,
          background: colours.accent,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 10px 30px rgba(47,107,79,0.45)",
          opacity: link,
          transform: `scale(${interpolate(link, [0, 1], [0.6, 1])})`,
        }}
      >
        <Lock />
      </div>
      <Caption text={scene.caption} sub={scene.subcaption} align="center" top={HEIGHT - 250} />
    </AbsoluteFill>
  );
};

const Payoff: React.FC<{ scene: Scene }> = ({ scene }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <Img
        src={staticFile("app-icon.svg")}
        style={{
          position: "absolute",
          width: 96,
          height: 96,
          left: WIDTH / 2 - 48,
          top: HEIGHT - 420,
          opacity: ease(frame, 0, 1, 20, 16),
          transform: `translateY(${ease(frame, 20, 0, 20, 20)}px)`,
        }}
      />
      <Sequence from={24} layout="none">
        <Caption text={scene.caption} sub={scene.subcaption} align="center" />
      </Sequence>
    </AbsoluteFill>
  );
};

export const Film: React.FC<FilmProps> = ({ useClips }) => {
  useBrandFont();
  const byId = Object.fromEntries(scenes.map((scene) => [scene.id, scene]));
  const firstRecorded = byId.save.from;
  const payoff = byId.payoff;
  const beside = scenes.find((scene) => scene.beside);
  return (
    <AbsoluteFill style={{ backgroundColor: colours.paper }}>
      <Background />
      <Sequence from={byId.attention.from} durationInFrames={byId.attention.length}>
        <Fade length={byId.attention.length}>
          <Attention scene={byId.attention} />
        </Fade>
      </Sequence>
      <Sequence from={byId.problem.from} durationInFrames={byId.problem.length}>
        <Fade length={byId.problem.length}>
          <Problem scene={byId.problem} />
        </Fade>
      </Sequence>
      <Sequence from={firstRecorded}>
        <PhoneStage useClips={useClips} start={firstRecorded} besideAt={beside?.from ?? payoff.from} payoffAt={payoff.from} />
      </Sequence>
      {scenes
        .filter((scene) => scene.clip && !scene.beside) // A scene beside the computer draws its caption under both.
        .map((scene) => (
          <Sequence key={scene.id} from={scene.from} durationInFrames={scene.length}>
            <Fade length={scene.length}>
              <Caption text={scene.caption} />
            </Fade>
          </Sequence>
        ))}
      {beside ? (
        <Sequence from={beside.from} durationInFrames={beside.length}>
          <Fade length={beside.length}>
            <Sync scene={beside} />
          </Fade>
        </Sequence>
      ) : null}
      <Sequence from={payoff.from} durationInFrames={payoff.length}>
        <Payoff scene={payoff} />
      </Sequence>
    </AbsoluteFill>
  );
};
