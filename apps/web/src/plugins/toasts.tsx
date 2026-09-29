import { For, Show, createSignal } from "solid-js";
import { describeError } from "@lemma/client";
import { AlertIcon, CheckIcon, CopyIcon, ExternalIcon, XIcon } from "../components/icons.tsx";
import { copyText } from "../components/markdown.tsx";
import { Client, Layers, Notify, Slots } from "../ui/contracts.ts";
import type { Toast } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

function CodeBox(props: { code: string }) {
  const [copied, setCopied] = createSignal(false);
  return (
    <div class="device-code">
      <code>{props.code}</code>
      <button
        class="button small"
        onClick={() =>
          void copyText(props.code).then((ok) => {
            setCopied(ok);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        <CopyIcon /> {copied() ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function ToastView(props: { toast: Toast; onDismiss: () => void }) {
  const [copied, setCopied] = createSignal(false);
  const copy = () =>
    void copyText(props.toast.message).then((ok) => {
      setCopied(ok);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <div class={`toast toast-${props.toast.level}`} role={props.toast.level === "error" ? "alert" : "status"}>
      <div class="toast-main">
        <Show when={props.toast.level !== "info"}>
          <AlertIcon />
        </Show>
        <div class="toast-text">
          <span>{props.toast.message}</span>
          <Show when={props.toast.source && props.toast.source !== "client"}>
            <span class="toast-source">{props.toast.source}</span>
          </Show>
        </div>
        <Show when={props.toast.level !== "info"}>
          <button class="icon-button" aria-label="Copy message" data-tip={copied() ? "Copied" : "Copy"} onClick={copy}>
            {copied() ? <CheckIcon /> : <CopyIcon />}
          </button>
        </Show>
        <button class="icon-button" aria-label="Dismiss" onClick={() => props.onDismiss()}>
          <XIcon />
        </button>
      </div>
      <Show when={props.toast.code}>{(code) => <CodeBox code={code()} />}</Show>
      <Show when={props.toast.links?.length}>
        <div class="toast-links">
          <For each={props.toast.links}>
            {(link) => (
              <a class="button small" href={link.url} target="_blank" rel="noopener noreferrer">
                {link.label ?? new URL(link.url, location.href).host} <ExternalIcon />
              </a>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** Messages for the user: the app's own, and the host's notices (login progress, faults, reloads). */
export default defineUiPlugin({
  id: "toasts",
  requires: { client: Client, slots: Slots },
  provides: { notify: Notify },
  setup: ({ client, slots }, plugin) => {
    const [toasts, setToasts] = createSignal<readonly Toast[]>([]);
    const timers = new Set<number>();
    let seq = 0;
    const dismiss = (id: number) => setToasts((all) => all.filter((toast) => toast.id !== id));
    const toast = (notice: Omit<Toast, "id">): number => {
      const id = ++seq;
      setToasts((all) => [...all.slice(-5), { ...notice, id }]);
      // A code or link is something to act on; it stays until dismissed or its login ends.
      if (notice.code === undefined && (notice.links === undefined || notice.links.length === 0)) {
        const timer = window.setTimeout(
          () => {
            timers.delete(timer);
            dismiss(id);
          },
          notice.level === "error" ? 12_000 : notice.level === "warning" ? 8_000 : 5_000,
        );
        timers.add(timer);
      }
      return id;
    };
    plugin.onCleanup(() => {
      for (const timer of timers) window.clearTimeout(timer);
    });
    plugin.onCleanup(
      client.onEvent((event) => {
        if (event.type !== "notice") return;
        const { level, message, source, links, code } = event.notice;
        toast({
          level,
          message,
          ...(source === undefined ? {} : { source }),
          ...(links === undefined ? {} : { links }),
          ...(code === undefined ? {} : { code }),
        });
      }),
    );
    plugin.onCleanup(
      slots.add(Layers, {
        id: "toasts",
        order: 100,
        component: () => (
          <div class="toasts" aria-live="polite">
            <For each={toasts()}>{(item) => <ToastView toast={item} onDismiss={() => dismiss(item.id)} />}</For>
          </div>
        ),
      }),
    );
    return {
      notify: {
        toasts,
        toast,
        dismiss,
        dismissWhere: (drop: (toast: Toast) => boolean) => setToasts((all) => all.filter((item) => !drop(item))),
        report: (error: unknown, context?: string) =>
          void toast({ level: "error", message: context === undefined ? describeError(error) : `${context}: ${describeError(error)}` }),
      },
    };
  },
});
