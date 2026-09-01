/** Hero chat demo — a scripted "Claude ↔ Telegram" exchange.
 *
 * Illustrative, not live data: the prompt is the real `examples.morningPrompt`
 * string, the digest below it is a mock-up of what a reply looks like. Chat
 * names, the status line and the highlight note are invented sample data, but
 * they are localised too — an English “connected / Team Sync / Family” block
 * under a Russian or Japanese prompt reads as a half-finished translation, not
 * as someone else's Telegram. Only the brand line (`Claude ↔ Telegram`) and the
 * tool name (`telegram-read-messages`) stay in English, as they should.
 *
 * Server component: the cascade is pure CSS animation-delay, no JS timers.
 * `aria-hidden` because it is decorative — the hero copy beside it already
 * states what the product does, and a screen reader walking a fake chat
 * transcript would just add noise. */

import { useTranslations } from "next-intl";
import { TbSunFilled } from "react-icons/tb";
import s from "@/app/landing.module.css";

export function ChatDemo() {
  const t = useTranslations("examples");

  const sampleChats = [
    { name: t("demoChatWork"), unread: 12 },
    { name: t("demoChatDesign"), unread: 5 },
    { name: t("demoChatFamily"), unread: 3, muted: true },
  ];

  return (
    <div className={s.demo} aria-hidden>
      <div className={s.demoHead}>
        {/* biome-ignore lint/performance/noImgElement: served from the Hono backend, not next/image-optimised. */}
        <img src="/icon.svg" alt="" width={26} height={26} />
        <div>
          <div className={s.demoTitle}>Claude ↔ Telegram</div>
          <div className={s.demoStatus}>● {t("demoStatus")}</div>
        </div>
      </div>

      <div className={s.demoBody}>
        <div className={s.bubbleOut}>“{t("morningPrompt")}”</div>

        <div className={s.toolChip}>
          <span className={s.toolDots}>
            <i />
            <i />
            <i />
          </span>
          telegram-read-messages
        </div>

        <div className={s.bubbleIn}>
          <div className={s.digestHead}>
            <TbSunFilled size={17} color="var(--tg-orange)" />
            {t("morningTitle")}
          </div>

          {sampleChats.map((chat) => (
            <div key={chat.name} className={s.digestRow}>
              <span>{chat.name}</span>
              <span className={`${s.unread} ${chat.muted ? s.unreadMuted : ""}`}>{chat.unread}</span>
            </div>
          ))}

          <div className={s.digestDivider} />
          <div className={s.digestNote}>
            🔥 “{t("demoHighlight")}” · {t("demoChatWork")}
          </div>
        </div>
      </div>
    </div>
  );
}
