import { useCallback, useState } from "react";
import { VoiceInput } from "./VoiceInput";
import { appendTranscript } from "../audio/pcm";

interface Props {
  conversationId?: string | null;
  title: string | null;
  sending: boolean;
  taskConversation?: boolean;
  quickThinking?: boolean;
  interrupting?: boolean;
  onSend: (text: string) => void | boolean | Promise<void | boolean>;
  onInterrupt?: () => void;
  inserting?: boolean;
  notice?: string;
  unavailableReason?: string;
}

export function ChatComposer({ conversationId, title, sending, taskConversation = false, quickThinking = false, interrupting = false, onSend, onInterrupt, inserting = false, notice, unavailableReason }: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftKey = conversationId ?? title ?? "empty";
  const input = drafts[draftKey] ?? "";
  const setInput = (text: string) => setDrafts(current => ({ ...current, [draftKey]: text }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const insertError = errors[draftKey] ?? "";
  const setInsertError = (error: string) => setErrors(current => ({ ...current, [draftKey]: error }));
  const [voiceBusyKey, setVoiceBusyKey] = useState<string | null>(null);
  const voiceBusy = voiceBusyKey === draftKey;
  const onVoiceBusy = useCallback((busy: boolean) => {
    setVoiceBusyKey(current => busy ? draftKey : current === draftKey ? null : current);
  }, [draftKey]);
  const onVoiceText = useCallback((text: string) => {
    setDrafts(current => ({ ...current, [draftKey]: appendTranscript(current[draftKey] ?? "", text) }));
  }, [draftKey]);
  const disabled = !title || interrupting || inserting || (quickThinking && sending) || voiceBusy;
  const activityLabel = !title
    ? unavailableReason ?? "请先新建对话"
    : sending
      ? quickThinking ? "正在回复…" : taskConversation ? "正在处理…" : "正在回复…"
      : "";

  const submit = async () => {
    const text = input.trim();
    if (!text || disabled) return;
    setInput("");
    setInsertError("");
    try {
      const accepted = await onSend(text);
      if (accepted === false) setDrafts(current => !current[draftKey] ? { ...current, [draftKey]: input } : current);
    } catch (error) {
      setInsertError(error instanceof Error ? error.message : String(error));
      setDrafts(current => !current[draftKey] ? { ...current, [draftKey]: input } : current);
    }
  };

  return <div className="chat-composer-wrap">
    <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <textarea
        aria-label="消息输入"
        className="chat-composer__input"
        placeholder={unavailableReason ?? (sending
          ? quickThinking ? "可以先写下追问，等本轮完成后发送…" : "补充你的判断；发送后会在下一个步骤边界处理…"
          : title ? "输入消息…" : "先在对话列表中新建对话")}
        value={input}
        disabled={!title || interrupting}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            submit();
          }
        }}
        rows={3}
      />
      {(notice || insertError) && <p className="chat-composer__notice" role="status">{insertError || notice}</p>}
      <div className="chat-composer__footer">
        {activityLabel && <div className="chat-composer__status" role="status">
          <span className={`chat-composer__status-dot${sending ? " is-running" : !title ? " is-idle" : ""}`} aria-hidden="true" />
          <span className="chat-composer__activity" title={activityLabel}>{activityLabel}</span>
        </div>}
        <div className="chat-composer__actions">
          <VoiceInput key={draftKey} disabled={!title || interrupting || inserting} onText={onVoiceText} onBusy={onVoiceBusy} />
          {sending && onInterrupt && <button className="chat-composer__interrupt" type="button" onClick={onInterrupt} disabled={interrupting}>
            {interrupting ? "正在暂停…" : "暂停执行"}
          </button>}
          <button className="chat-composer__send" type="submit" disabled={disabled || !input.trim()}>
            {inserting ? "正在发送…" : sending ? quickThinking ? "等待回答" : "补充要求" : "发送"}
          </button>
        </div>
      </div>
    </form>
  </div>;
}
