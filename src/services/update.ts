import type { UpdateStatus } from "../types";

/** The page of the Linux packages: the way out when the system cannot install one (sheet 42). */
export const DOWNLOAD_PAGE = "https://koona.app/pin/";

/** States with a new version in play: the row in the sidebar and the dialog (sheet 42). */
export type Offer = Extract<UpdateStatus, { version: string }>;

/** The row shows from the offer until the new version runs, or after a failure, until a retry. */
export function offer(status: UpdateStatus | null): Offer | null {
  return status && "version" in status ? status : null;
}

/** Whole percent of the download, when the size is known. */
export function percent(status: UpdateStatus | null): number | null {
  if (status?.state !== "downloading" || !status.total) return null;
  return Math.min(100, Math.floor((status.received * 100) / status.total));
}

/** «4.1 MB» in the interface's language. */
export function megabytes(bytes: number, language: string): string {
  return new Intl.NumberFormat(language, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 }).format(bytes / 1_000_000);
}

/** The version's entry in the site's changelog: «Full changelog» (NP-040). */
export function notesUrl(status: Offer): string {
  return status.state === "available" ? status.notes_url : `https://koona.app/pin/changelog/#${status.version}`;
}
