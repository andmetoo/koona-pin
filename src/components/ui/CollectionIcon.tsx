import {
  BookOpen, Bookmark, Bot, Briefcase, Calendar, Camera, Car, ChartLine, Cloud, Code, Coffee, Cpu, Dumbbell, Film, FlaskConical,
  Folder, Gamepad2, Gift, Globe, GraduationCap, Heart, House, Leaf, Lightbulb, LucideIcon, MapPin, Music, Newspaper, Palette,
  PawPrint, PenTool, Plane, Rocket, ShoppingCart, Star, Sun, Terminal, Users, Utensils, Wallet, Wrench,
} from "lucide-react";
import { CollectionIconName, collectionTint, iconKind } from "../../services/collections";
import { Icon } from "../icons";

/** The Lucide glyph of each name a collection may wear (2.19.0), in the picker's order. */
export const COLLECTION_GLYPHS: Record<CollectionIconName, LucideIcon> = {
  folder: Folder, code: Code, palette: Palette, "book-open": BookOpen, briefcase: Briefcase, house: House, heart: Heart, star: Star,
  bookmark: Bookmark, music: Music, film: Film, camera: Camera, "gamepad-2": Gamepad2, plane: Plane, "map-pin": MapPin,
  "shopping-cart": ShoppingCart, utensils: Utensils, coffee: Coffee, dumbbell: Dumbbell, "graduation-cap": GraduationCap,
  "flask-conical": FlaskConical, cpu: Cpu, wrench: Wrench, newspaper: Newspaper, globe: Globe, lightbulb: Lightbulb,
  "pen-tool": PenTool, rocket: Rocket, leaf: Leaf, "paw-print": PawPrint, car: Car, wallet: Wallet, "chart-line": ChartLine,
  calendar: Calendar, users: Users, gift: Gift, bot: Bot, terminal: Terminal, cloud: Cloud, sun: Sun,
};

/**
 * A collection's mark (2.19.0, frame N1): its icon in its colour, the emoji
 * the person typed, or the dot as before. A 16 px box, so names line up.
 */
export function CollectionIcon({
  collection,
  size = 16,
  dot = 8,
  className = "",
}: {
  collection: { id: number; color: string | null; icon: string | null };
  size?: number;
  /** The dot's size when there is no icon. */
  dot?: number;
  className?: string;
}) {
  const kind = iconKind(collection.icon);
  const color = collectionTint(collection);
  return (
    <span aria-hidden className={`flex shrink-0 items-center justify-center ${className}`} style={{ width: size, height: size, color }}>
      {kind?.kind === "lucide" ? (
        <Icon icon={COLLECTION_GLYPHS[kind.name]} size={size} />
      ) : kind?.kind === "emoji" ? (
        <span className="leading-none" style={{ fontSize: size - 2 }}>
          {kind.text}
        </span>
      ) : (
        <span className="rounded-full" style={{ width: dot, height: dot, background: color }} />
      )}
    </span>
  );
}
