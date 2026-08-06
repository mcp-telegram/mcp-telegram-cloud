/** Hero chat demo — a scripted "Claude ↔ Telegram" exchange.
 *
 * Illustrative, not live data: the prompt is the real `examples.morningPrompt`
 * string, the digest below it is a mock-up of what a reply looks like. Chat
 * names and counts are invented sample data and stay untranslated on purpose —
 * they read as a screenshot of someone's Telegram, not as UI copy.
 *
 * Server component: the cascade is pure CSS animation-delay, no JS timers.
 * `aria-hidden` because it is decorative — the hero copy beside it already
 * states what the product does, and a screen reader walking a fake chat
 * transcript would just add noise. */

import { useTranslations } from "next-intl";
import { TbSunFilled } from "react-icons/tb";
import s from "@/app/landing.module.css";

const SAMPLE_CHATS = [
  { name: "Team Sync", unread: 12 },
  { name: "Design", unread: 5 },
  { name: "Family ❤️", unread: 3, muted: true },
];

export function ChatDemo() {
  const t = useTranslations("examples");

  return (
    <div className={s.demo} aria-hidden>
      <div className={s.demoHead}>
        {/* biome-ignore lint/performance/noImgElement: served from the Hono backend, not next/image-optimised. */}
        <img src="/icon.svg" alt="" width={26} height={26} />
        <div>
          <div className={s.demoTitle}>Claude ↔ Telegram</div>
          <div className={s.demoStatus}>● connected</div>
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

          {SAMPLE_CHATS.map((chat) => (
            <div key={chat.name} className={s.digestRow}>
              <span>{chat.name}</span>
              <span className={`${s.unread} ${chat.muted ? s.unreadMuted : ""}`}>{chat.unread}</span>
            </div>
          ))}

          <div className={s.digestDivider} />
          <div className={s.digestNote}>🔥 “deadline → Friday 18:00” · Team Sync</div>
        </div>
      </div>
    </div>
  );
}
