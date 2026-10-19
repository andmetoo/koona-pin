import { ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "lucide-react";
import { useTranslation } from "react-i18next";
import { McpSetup, McpStatus } from "../../types";
import { api, desktopOnly } from "../../services/api";
import { describeError } from "../../services/errors";
import { Icon } from "../icons";
import { Button } from "../ui/Button";
import { Dot, Segmented, TabPanels } from "../ui/Controls";
import { Dialog } from "../ui/Dialog";
import { HelpLink } from "../ui/HelpLink";

type Client = "desktop" | "code" | "chatgpt" | "custom";
const CLIENTS: readonly Client[] = ["desktop", "code", "chatgpt", "custom"];

/**
 * «Connect an AI assistant» (NP-091, sheet 44), as «Connect browser» (frame 18): Claude Desktop installs
 * the .mcpb package or takes the JSON, Claude Code a command, the ChatGPT desktop app the server's path (or Codex a
 * command: they share the list), any other MCP app the same JSON. Every
 * path is the real one of koonapin-mcp on this computer.
 */
export function AssistantDialog({
  onCopy,
  onNotice,
  onClose,
}: {
  onCopy: (text: string) => void;
  onNotice: (text: string, alert?: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [client, setClient] = useState<Client>("desktop");
  const [setup, setSetup] = useState<McpSetup | null>(null);
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  // The caller's notice may be a new function on every render; the setup is read once.
  const notice = useRef(onNotice);
  notice.current = onNotice;
  useEffect(() => {
    const desktop = desktopOnly();
    void desktop.getMcpSetup().then(setSetup).catch((err) => notice.current(describeError(err), true));
    void desktop.getMcpStatus().then(setStatus).catch(() => {});
    return desktop.onMcpStatus(setStatus);
  }, []);
  const access = status?.access ?? "off";
  const state = access === "off" ? t("assistant.statusOff") : t(access === "read" ? "assistant.statusRead" : "assistant.statusAdd");
  const code = (text: string | undefined) => text !== undefined && <CodeBlock text={text} onCopy={onCopy} />;
  const install = () => {
    setInstalling(true);
    desktopOnly()
      .saveMcpb()
      .then((name) => name && onNotice(t("assistant.saved", { name })))
      .catch((err) => onNotice(describeError(err), true))
      .finally(() => setInstalling(false));
  };
  const steps: Record<Client, { title: string; text: string; extra?: ReactNode }[]> = {
    desktop: [
      {
        title: t("assistant.installTitle"),
        text: t("assistant.installText"),
        extra: (
          <Button variant="primary" className="mt-2" disabled={!setup?.installed || installing} onClick={install}>
            {t("assistant.installButton")}
          </Button>
        ),
      },
      { title: t("assistant.askTitle"), text: t("assistant.askText") },
    ],
    code: [
      { title: t("assistant.runTitle"), text: t("assistant.runText"), extra: code(setup?.claude_code) },
      { title: t("assistant.checkTitle"), text: t("assistant.checkText") },
    ],
    // The desktop app takes the server's path; Codex shares its list (NP-091).
    chatgpt: [
      { title: t("assistant.chatgptTitle"), text: t("assistant.chatgptText"), extra: code(setup?.server) },
      { title: t("assistant.codexTitle"), text: t("assistant.codexText"), extra: code(setup?.codex) },
    ],
    custom: [
      { title: t("assistant.customTitle"), text: t("assistant.customText") },
      { title: t("assistant.customAddTitle"), text: t("assistant.customAddText"), extra: code(setup?.json) },
    ],
  };
  return (
    <Dialog title={t("assistant.title")} onClose={onClose}>
      <div className="flex w-[440px] max-w-full flex-col gap-4 text-sm">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary text-icon">
            <Icon icon={Link} />
          </span>
          <div className="min-w-0">
            <h3 className="text-md font-semibold">{t("assistant.lead")}</h3>
            <p data-mcp={access} className="mt-0.5 flex items-center gap-2 text-xs text-muted">
              <Dot color={access === "off" ? "var(--np-ochre)" : "var(--np-green)"} className="size-1.5" />
              {state}
            </p>
          </div>
        </div>
        <Segmented<Client>
          label={t("assistant.clients")}
          value={client}
          onChange={setClient}
          options={[
            { value: "desktop", label: "Claude Desktop" },
            { value: "code", label: "Claude Code" },
            { value: "chatgpt", label: "ChatGPT" },
            { value: "custom", label: t("assistant.custom") },
          ]}
        />
        {setup && !setup.installed && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-xs leading-[17px] text-on-danger-soft">
            {t("errors.detail.server_missing")}
          </p>
        )}
        <TabPanels value={client} tabs={CLIENTS}>
          {(shown) => (
            <>
              <ol className="flex flex-col gap-4">
                {steps[shown].map((step, index) => (
                  <li key={step.title} className="flex gap-3">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-2xs font-semibold text-on-accent-soft">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{step.title}</div>
                      <p className="mt-0.5 leading-[18px] text-muted">{step.text}</p>
                      {step.extra}
                    </div>
                  </li>
                ))}
              </ol>
              {shown === "chatgpt" && <p className="ml-8 text-xs leading-4 text-muted">{t("assistant.chatgptNote")}</p>}
              {shown === "desktop" && (
                <div className="flex flex-col gap-2.5 border-t border-divider pt-4">
                  <div>
                    <div className="font-medium">{t("assistant.manualTitle")}</div>
                    <p className="mt-0.5 leading-[18px] text-muted">{t("assistant.manualText")}</p>
                  </div>
                  {code(setup?.json)}
                </div>
              )}
            </>
          )}
        </TabPanels>
        <p className="border-t border-divider pt-4 text-xs leading-4 text-muted">
          {t("assistant.note")} <HelpLink topic="aiAssistants" onOpen={(url) => void api.openUrl(url).catch((err) => onNotice(describeError(err), true))} />
        </p>
      </div>
    </Dialog>
  );
}

/** A command or JSON to paste, with «Copy» in its corner; a long path wraps. */
function CodeBlock({ text, onCopy }: { text: string; onCopy: (text: string) => void }) {
  const { t } = useTranslation();
  const oneLine = !text.includes("\n");
  return (
    <div className="relative mt-2.5 rounded-lg bg-secondary">
      <pre
        className={`py-3 pl-3 font-mono text-xs leading-[17px] whitespace-pre-wrap [overflow-wrap:anywhere] select-text ${oneLine ? "pr-[76px]" : "pr-3"}`}
      >
        {text}
      </pre>
      <Button variant="outline" className="absolute top-1.5 right-1.5 h-[26px] bg-card px-2.5 text-xs" onClick={() => onCopy(text)}>
        {t("common.copy")}
      </Button>
    </div>
  );
}
