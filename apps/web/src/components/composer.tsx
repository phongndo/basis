import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { ImageContent, ModelInfo, PromptContent, ThinkingLevel } from "@basis/contracts";
import { contextSize } from "../model/format.ts";
import { DEFAULT_THINKING, filterModels, thinkingLevels } from "../model/prefs.ts";
import {
  cancel,
  chooseModel,
  chooseThinking,
  connected,
  effectiveThinking,
  favoriteModels,
  hasConfiguredProvider,
  isBusy,
  openDialog,
  selectedModel,
  send,
  state,
  toast,
  toggleFavorite,
} from "../store.ts";
import { BrainIcon, CheckIcon, ChevronDownIcon, ImageIcon, KeyIcon, SearchIcon, SendIcon, StarIcon, StopIcon, XIcon } from "./icons.tsx";
import { Popover } from "./popover.tsx";
import type { Placement } from "./popover.tsx";
import { WorkspaceBar } from "./workspace-bar.tsx";

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

// Unsent text per session (and for the new-chat state) survives switching sessions.
const drafts = new Map<string, string>();
const draftKey = () => state.activeId ?? "";

let focusComposer: (() => void) | undefined;
export const focusPrompt = (): void => focusComposer?.();
let openPicker: (() => void) | undefined;
export const openModelPicker = (): void => openPicker?.();

export function Composer() {
  const [text, setText] = createSignal(drafts.get(draftKey()) ?? "");
  const [images, setImages] = createSignal<readonly ImageContent[]>([]);
  const [dragging, setDragging] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  let input!: HTMLTextAreaElement;
  let fileInput!: HTMLInputElement;

  createEffect(
    on(
      () => state.activeId,
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
    focusComposer = () => input.focus();
    input.focus();
    resize();
  });
  onCleanup(() => {
    focusComposer = undefined;
  });

  const canSend = () => connected() && !isBusy() && !sending() && (text().trim() !== "" || images().length > 0);
  const acceptsImages = () => selectedModel()?.input.includes("image") ?? true;

  const submit = async () => {
    if (!canSend()) return;
    const content: PromptContent = [...(text().trim() === "" ? [] : [{ type: "text" as const, text: text() }]), ...images()];
    // Sending a new chat creates a session and switches to it, so remember which draft this was.
    const key = draftKey();
    const sent = { text: text(), images: images() };
    setSending(true);
    const ok = await send(content);
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

  const addFiles = async (files: Iterable<File>) => {
    const images = [...files].filter((file) => file.type.startsWith("image/"));
    const supported = images.filter((file) => IMAGE_TYPES.has(file.type));
    const accepted = supported.filter((file) => file.size <= MAX_IMAGE_BYTES);
    const unsupported = images.length - supported.length;
    const tooLarge = supported.length - accepted.length;
    if (unsupported > 0)
      toast({ level: "warning", message: `${unsupported === 1 ? "An image was" : `${unsupported} images were`} not attached: use PNG, JPEG, GIF, or WebP.` });
    if (tooLarge > 0)
      toast({
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
    } else if (event.key === "Escape" && isBusy()) {
      event.preventDefault();
      cancel();
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
    if (!connected()) return "Waiting for the host…";
    if (isBusy()) return "Working…";
    return state.activeId === undefined ? "Ask anything, or describe a task" : "Reply…";
  };

  return (
    <div class="composer-wrap">
      <Show when={state.providersLoaded && !hasConfiguredProvider()}>
        <div class="callout callout-info composer-callout">
          <KeyIcon />
          <span>No model provider is set up yet.</span>
          <button class="button button-primary small" onClick={() => openDialog("providers")}>
            Log in to a provider
          </button>
        </div>
      </Show>
      <form
        class="composer"
        classList={{ dragging: dragging(), busy: isBusy() }}
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
            <ModelPicker
              afterPick={focusPrompt}
              controller={(handle) => {
                openPicker = handle.open;
              }}
            />
            <ThinkingPicker afterPick={focusPrompt} />
          </div>
          <div class="composer-actions">
            <button type="button" class="icon-button" data-tip="Attach images" aria-label="Attach images" onClick={() => fileInput.click()}>
              <ImageIcon />
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              hidden
              onChange={(event) => {
                void addFiles(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
              }}
            />
            <Show
              when={isBusy()}
              fallback={
                <button type="submit" class="send" disabled={!canSend()} aria-label="Send" data-tip="Send">
                  <SendIcon />
                </button>
              }
            >
              <button type="button" class="send stop" aria-label="Stop" data-tip="Stop" onClick={cancel}>
                <StopIcon />
              </button>
            </Show>
          </div>
        </div>
      </form>
      <WorkspaceBar />
    </div>
  );
}

const LEVEL_LABEL: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** The selected model's own reasoning levels; the choice is remembered per model. */
export function ThinkingPicker(props: { placement?: Placement; afterPick?: () => void }) {
  const levels = createMemo(() => thinkingLevels(selectedModel()));
  return (
    <Show when={levels().length > 0}>
      <span class="control-separator" aria-hidden="true" />
      <Popover
        label="Reasoning"
        tip={`Reasoning for ${selectedModel()?.name ?? "this model"}`}
        triggerClass="select-chip"
        placement={props.placement ?? "top-start"}
        trigger={
          <>
            <BrainIcon />
            <span>{LEVEL_LABEL[effectiveThinking() ?? DEFAULT_THINKING]}</span>
            <ChevronDownIcon />
          </>
        }
      >
        {(close) => (
          <>
            <div class="menu-section">Reasoning · {selectedModel()?.name}</div>
            <For each={levels()}>
              {(level) => (
                <button
                  class="menu-item"
                  role="menuitemradio"
                  aria-checked={effectiveThinking() === level}
                  onClick={() => {
                    chooseThinking(level);
                    close();
                    props.afterPick?.();
                  }}
                >
                  <span class="menu-check">
                    <Show when={effectiveThinking() === level}>
                      <CheckIcon />
                    </Show>
                  </span>
                  {LEVEL_LABEL[level]}
                </button>
              )}
            </For>
          </>
        )}
      </Popover>
    </Show>
  );
}

type Rail = "favorites" | "all" | string;

/** Picks the preferred model, shared by the composer and settings. */
export function ModelPicker(props: { placement?: Placement; afterPick?: () => void; controller?: (handle: { readonly open: () => void }) => void }) {
  const [query, setQuery] = createSignal("");
  const [rail, setRail] = createSignal<Rail>("all");
  const providerName = (id: string) => state.providers.find((provider) => provider.id === id)?.name ?? id;
  const providers = createMemo(() => [...new Set(state.models.map((model) => model.provider))]);
  const shown = createMemo((): readonly ModelInfo[] => {
    // Searching always covers every model.
    if (query().trim() !== "") return filterModels(state.models, query()).flatMap((group) => group.models);
    if (rail() === "favorites") return favoriteModels().flatMap((ref) => state.models.filter((model) => model.ref === ref));
    if (rail() === "all") return state.models;
    return state.models.filter((model) => model.provider === rail());
  });
  const label = () => selectedModel()?.name ?? (state.model !== undefined && state.modelsLoaded ? "Model unavailable" : "Choose a model");
  const pick = (ref: string, close: () => void) => {
    chooseModel(ref);
    close();
    props.afterPick?.();
  };
  const railKeys = (event: KeyboardEvent) => {
    if (query() !== "" || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    const keys: Rail[] = [...(favoriteModels().length > 0 ? ["favorites"] : []), "all", ...providers()];
    const index = keys.indexOf(rail());
    event.preventDefault();
    setRail(keys[(index + (event.key === "ArrowRight" ? 1 : -1) + keys.length) % keys.length]!);
  };

  return (
    <Popover
      label="Model"
      tip={selectedModel() === undefined ? "Model" : `${providerName(selectedModel()!.provider)} · ${selectedModel()!.id}`}
      triggerClass="select-chip"
      placement={props.placement ?? "top-start"}
      menuClass="model-menu"
      onOpen={() => {
        setQuery("");
        const current = selectedModel();
        setRail(favoriteModels().length > 0 && (current === undefined || favoriteModels().includes(current.ref)) ? "favorites" : (current?.provider ?? "all"));
      }}
      {...(props.controller === undefined ? {} : { controller: props.controller })}
      trigger={
        <>
          <span class="picker-label">{label()}</span>
          <ChevronDownIcon />
        </>
      }
    >
      {(close) => (
        <>
          <label class="model-search">
            <SearchIcon />
            <input
              placeholder="Search models"
              aria-label="Search models"
              autocomplete="off"
              spellcheck={false}
              data-autofocus
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={railKeys}
            />
          </label>
          <div class="model-body">
            <nav class="model-rail" aria-label="Providers">
              <Show when={favoriteModels().length > 0}>
                <button
                  type="button"
                  class="rail-item"
                  classList={{ active: query() === "" && rail() === "favorites" }}
                  tabindex="-1"
                  onClick={() => {
                    setQuery("");
                    setRail("favorites");
                  }}
                >
                  <StarIcon filled /> Favorites
                </button>
              </Show>
              <button
                type="button"
                class="rail-item"
                classList={{ active: query() !== "" || rail() === "all" }}
                tabindex="-1"
                onClick={() => {
                  setQuery("");
                  setRail("all");
                }}
              >
                All models
              </button>
              <div class="rail-sep" />
              <For each={providers()}>
                {(provider) => (
                  <button
                    type="button"
                    class="rail-item"
                    classList={{ active: query() === "" && rail() === provider }}
                    tabindex="-1"
                    onClick={() => {
                      setQuery("");
                      setRail(provider);
                    }}
                  >
                    <span class="rail-name">{providerName(provider)}</span>
                  </button>
                )}
              </For>
            </nav>
            <div class="model-list" role="listbox">
              <For each={shown()}>
                {(model) => {
                  const selected = () => selectedModel()?.ref === model.ref;
                  const favorite = () => favoriteModels().includes(model.ref);
                  return (
                    <div class="model-row menu-item" role="option" aria-selected={selected()} onClick={() => pick(model.ref, close)}>
                      <span class="model-text">
                        <span class="model-name">{model.name}</span>
                        <span class="model-meta">
                          <span>{providerName(model.provider)}</span>
                          <span class="dot" />
                          <span>{contextSize(model.contextWindow)}</span>
                          <Show when={model.reasoning}>
                            <span class="meta-icon" data-tip="Reasoning">
                              <BrainIcon />
                            </span>
                          </Show>
                          <Show when={model.input.includes("image")}>
                            <span class="meta-icon" data-tip="Images">
                              <ImageIcon />
                            </span>
                          </Show>
                        </span>
                      </span>
                      <Show when={selected()}>
                        <span class="model-current">
                          <CheckIcon />
                        </span>
                      </Show>
                      <button
                        type="button"
                        class="model-star"
                        classList={{ on: favorite() }}
                        tabindex="-1"
                        aria-label={favorite() ? `Unfavorite ${model.name}` : `Favorite ${model.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleFavorite(model.ref);
                        }}
                      >
                        <StarIcon filled={favorite()} />
                      </button>
                    </div>
                  );
                }}
              </For>
              <Show when={shown().length === 0}>
                <div class="picker-empty">
                  <Show
                    when={state.models.length > 0}
                    fallback={
                      <>
                        No models yet.{" "}
                        <button
                          type="button"
                          class="link-button"
                          onClick={() => {
                            close();
                            openDialog("providers");
                          }}
                        >
                          Log in to a provider
                        </button>
                      </>
                    }
                  >
                    {rail() === "favorites" && query() === "" ? "Star a model to keep it here" : "No matching models"}
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </>
      )}
    </Popover>
  );
}
