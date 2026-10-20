/**
 * Where the app sends people for help (NP-092): the user help at koona.app/pin/help/, English only.
 * Installed copies keep these addresses for years, so each one is listed in the site's
 * pin/content/help/app-links.json, and the site's build fails when its page or anchor disappears;
 * help.test.ts checks this list against a copy of that file. A new link: the site's list first.
 */
export const HELP = {
  home: "",
  gettingStarted: "getting-started/",
  addExtension: "getting-started/#add-the-browser-extension",
  savingFails: "troubleshooting/#saving-from-the-browser-fails",
  libraryWontOpen: "troubleshooting/#the-library-wont-open",
  libraryMessages: "troubleshooting/#messages-while-you-work",
  readingMode: "troubleshooting/#a-page-wont-open-in-reading-mode",
  feedsDontUpdate: "troubleshooting/#feeds-dont-update",
  updatesFail: "troubleshooting/#updates-fail",
  sync: "sync/",
  aiAssistants: "ai-assistants/",
} as const;

export type HelpTopic = keyof typeof HELP;

export const helpUrl = (topic: HelpTopic) => `https://koona.app/pin/help/${HELP[topic]}`;
