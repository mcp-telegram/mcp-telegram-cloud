/** RSC outer wrapper + a small client island for the copy button. */

import { CopyExample } from "./CopyExample";
import s from "./ExampleCard.module.css";

type Props = {
  title: string;
  description: string;
  prompt: string;
  category: string;
  copyLabel: string;
  copiedLabel: string;
};

export function ExampleCard({ title, description, prompt, category, copyLabel, copiedLabel }: Props) {
  return (
    <article className={s.card}>
      <div className={s.head}>
        <h3 className={s.title}>{title}</h3>
        <span className={s.badge}>{category}</span>
      </div>
      <p className={s.desc}>{description}</p>
      <pre className={s.prompt}>{prompt}</pre>
      <div className={s.actions}>
        <CopyExample text={prompt} copyLabel={copyLabel} copiedLabel={copiedLabel} />
      </div>
    </article>
  );
}
