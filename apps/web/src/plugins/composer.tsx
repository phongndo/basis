import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { ImageContent, PromptContent } from "@lemma/contracts";
import {
  ActionIds,
  Actions,
  Client,
  ComposerActions,
  ComposerControls,
  ComposerFooter,
  ComposerNotices,
  ComposerRegion,
  Models,
  Notify,
  Sessions,
  Slots,
  Workspace,
} from "../ui/contracts.ts";
import type { ClientService, ComposerActionProps, ModelsService, NotifyService, SessionsService, WorkspaceService } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import type { SlotsService } from "../ui/slots.ts";
import { ChatIcon, ImageIcon, SendIcon, StopIcon, XIcon } from "../ui/parts.tsx";

/** The formats every provider accepts; others (SVG, HEIC, TIFF…) would fail every later request in the session. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Providers reject larger images (5 MB of base64), and a rejected image would be resent with every later prompt. Matches the read tool. */
const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;

const readImage = (file: File): Promise<ImageContent> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ type: "image", mimeType: file.type, data: url.slice(url.indexOf(",") + 1) });
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
    reader.readAsDataURL(file);
  });

interface Deps {
  readonly client: ClientService;
  readonly sessions: SessionsService;
  readonly models: ModelsService;
  readonly workspace: WorkspaceService;
  readonly notify: NotifyService;
  readonly slots: SlotsService;
  /** Unsent text per session (and for the new-chat state) survives switching sessions. */
  readonly drafts: Map<string, string>;
  readonly setFocus: (focus: (() => void) | undefined) => void;
}

function Composer(props: { deps: Deps }) {
  const { client, sessions, models, workspace, notify, slots, drafts } = props.deps;
  const draftKey = () => sessions.activeId() ?? "";
  const [text, setText] = createSignal(drafts.get(draftKey()) ?? "");
  const [images, setImages] = createSignal<readonly ImageContent[]>([]);
  const [dragging, setDragging] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  let input!: HTMLTextAreaElement;

  createEffect(
    on(
      sessions.activeId,
      () => {
        setText(drafts.get(draftKey()) ?? "");
        setImages([]);
        queueMicrotask(() => {
          resize();
          input.focus();
        });
      },
      { defer: true },
    ),
  );

  const resize = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  };

  onMount(() => {
    props.deps.setFocus(() => input.focus());
    input.focus();
    resize();
  });
  onCleanup(() => props.deps.setFocus(undefined));

  const canSend = () => client.connected() && !sessions.busy() && !sending() && (text().trim() !== "" || images().length > 0);
  const acceptsImages = () => models.selected()?.input.includes("image") ?? true;

  const submit = async () => {
    if (!canSend()) return;
    const content: PromptContent = [...(text().trim() === "" ? [] : [{ type: "text" as const, text: text() }]), ...images()];
    // Sending a new chat creates a session and switches to it, so remember which draft this was.
    const key = draftKey();
    const sent = { text: text(), images: images() };
    setSending(true);
    let ok = false;
    try {
      // A new chat may start in its own worktree, named from the prompt.
      const cwd = sessions.activeId() === undefined ? await workspace.newChatDir(sent.text) : undefined;
      ok = await sessions.send(content, { turn: models.turnOptions(), cwd });
    } catch (error) {
      notify.report(error, "Could not create a session");
    }
    setSending(false);
    drafts.delete(key);
    if (ok) {
      setText("");
      setImages([]);
    } else {
      // Refused: the prompt returns to the composer, which may now show the session `send` created.
      drafts.set(draftKey(), sent.text);
      setText(sent.text);
      setImages(sent.images);
    }
    queueMicrotask(resize);
  };

  const insert = (value: string) => {
    const start = input.selectionStart ?? text().length;
    const end = input.selectionEnd ?? start;
    const next = text().slice(0, start) + value + text().slice(end);
    setText(next);
    drafts.set(draftKey(), next);
    queueMicrotask(() => {
      input.focus();
      input.setSelectionRange(start + value.length, start + value.length);
      resize();
    });
  };
  const addFiles = async (files: Iterable<File>) => {
    const images = [...files].filter((file) => file.type.startsWith("image/"));
    const supported = images.filter((file) => IMAGE_TYPES.has(file.type));
    const accepted = supported.filter((file) => file.size <= MAX_IMAGE_BYTES);
    const unsupported = images.length - supported.length;
    const tooLarge = supported.length - accepted.length;
    if (unsupported > 0)
      notify.toast({
        level: "warning",
        message: `${unsupported === 1 ? "An image was" : `${unsupported} images were`} not attached: use PNG, JPEG, GIF, or WebP.`,
      });
    if (tooLarge > 0)
      notify.toast({
        level: "warning",
        message: `${tooLarge === 1 ? "An image was" : `${tooLarge} images were`} not attached: over the 3.75 MB limit providers accept.`,
      });
    if (accepted.length === 0) return;
    const read = await Promise.all(accepted.map(readImage));
    setImages((current) => [...current, ...read]);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !event.altKey) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape" && sessions.busy()) {
      event.preventDefault();
      sessions.cancel();
    }
  };

  const onPaste = (event: ClipboardEvent) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer !== null) void addFiles(event.dataTransfer.files);
  };

  const placeholder = () => {
    if (!client.connected()) return "Waiting for the host…";
    if (sessions.busy()) return "Working…";
    return sessions.activeId() === undefined ? "Ask anything, or describe a task" : "Reply…";
  };

  return (
    <div class="composer-wrap">
      <For each={slots.list(ComposerNotices)}>{(notice) => <Dynamic component={notice.component} />}</For>
      <form
        class="composer"
        classList={{ dragging: dragging(), busy: sessions.busy() }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onDragOver={(event) => {
          if (event.dataTransfer?.types.includes("Files")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDragging(false);
        }}
        onDrop={onDrop}
      >
        <Show when={images().length > 0}>
          <div class="attachments">
            <For each={images()}>
              {(image, index) => (
                <div class="attachment">
                  <img src={`data:${image.mimeType};base64,${image.data}`} alt="Attachment" />
                  <button
                    type="button"
                    class="attachment-remove"
                    aria-label="Remove image"
                    onClick={() => setImages((all) => all.filter((_, i) => i !== index()))}
                  >
                    <XIcon />
                  </button>
                </div>
              )}
            </For>
            <Show when={!acceptsImages()}>
              <span class="muted small">This model does not accept images.</span>
            </Show>
          </div>
        </Show>
        <textarea
          ref={input}
          rows={1}
          value={text()}
          placeholder={placeholder()}
          aria-label="Message"
          spellcheck={true}
          onInput={(event) => {
            setText(event.currentTarget.value);
            drafts.set(draftKey(), event.currentTarget.value);
            resize();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div class="composer-bar">
          <div class="composer-controls">
            <For each={slots.list(ComposerControls)}>{(control) => <Dynamic component={control.component} />}</For>
          </div>
          <div class="composer-actions">
            <For each={slots.list(ComposerActions)}>{(action) => <Dynamic component={action.component} addFiles={addFiles} insert={insert} />}</For>
            <Show
              when={sessions.busy()}
              fallback={
                <button type="submit" class="send" disabled={!canSend()} aria-label="Send" data-tip="Send">
                  <SendIcon />
                </button>
              }
            >
              <button type="button" class="send stop" aria-label="Stop" data-tip="Stop" onClick={() => sessions.cancel()}>
                <StopIcon />
              </button>
            </Show>
          </div>
        </div>
      </form>
      <For each={slots.list(ComposerFooter)}>{(item) => <Dynamic component={item.component} />}</For>
    </div>
  );
}

/** Where prompts are written: text, pasted or dropped images, send and stop. Its notices, controls, and footer are slots. */
/** The default composer action: pick images to attach. */
function AttachImages(props: ComposerActionProps) {
  let picker!: HTMLInputElement;
  return (
    <>
      <button type="button" class="icon-button" data-tip="Attach images" aria-label="Attach images" onClick={() => picker.click()}>
        <ImageIcon />
      </button>
      <input
        ref={picker}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(event) => {
          void props.addFiles([...(event.currentTarget.files ?? [])]);
          event.currentTarget.value = "";
        }}
      />
    </>
  );
}

export default defineUiPlugin({
  id: "composer",
  requires: { client: Client, sessions: Sessions, models: Models, workspace: Workspace, notify: Notify, slots: Slots },
  setup: (use, plugin) => {
    const [focus, setFocus] = createSignal<() => void>();
    const deps: Deps = { ...use, drafts: new Map(), setFocus: (next) => setFocus(() => next) };
    plugin.onCleanup(use.slots.add(ComposerRegion, { id: "composer", component: () => <Composer deps={deps} /> }));
    // Its own button goes through the slot other plugins add theirs to.
    plugin.onCleanup(use.slots.add(ComposerActions, { id: "composer.attach", order: 100, component: AttachImages }));
    plugin.onCleanup(
      use.slots.add(Actions, {
        id: ActionIds.focusComposer,
        order: 3,
        title: "Focus prompt",
        category: "Chat",
        icon: ChatIcon,
        keys: "/",
        when: () => focus() !== undefined,
        run: () => focus()?.(),
      }),
    );
  },
});
