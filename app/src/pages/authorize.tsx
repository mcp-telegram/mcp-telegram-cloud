import { renderToString } from "react-dom/server";
import { LanguageSwitcher } from "../components/LanguageSwitcher.js";
import { Layout } from "../components/Layout.js";
import { QrSection, qrCss } from "../components/QrSection.js";
import { createTranslator, getMessages } from "../i18n/index.js";
import { baseCss } from "../theme.js";

export type AuthorizeProps = {
  locale: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  /**
   * Canonical destination (scheme + host) the authorization code will be
   * delivered to. Supplied by the route, which already computed it; optional so
   * an older caller still renders, in which case it is derived from
   * `redirectUri` below rather than silently omitted.
   */
  redirectOriginKey?: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scripts?: readonly string[];
};

/** scheme + host of a redirect URI, or the raw value when it cannot be parsed. */
function destinationOf(redirectUri: string): string {
  try {
    const url = new URL(redirectUri);
    return url.host ? `${url.protocol}//${url.host}` : `${url.protocol}${url.pathname}`;
  } catch {
    return redirectUri;
  }
}

function AuthorizePage(props: AuthorizeProps) {
  const { locale, clientName } = props;
  const t = createTranslator(getMessages(locale));
  const destination = props.redirectOriginKey ?? destinationOf(props.redirectUri);

  // Build the SSE URL server-side so the island stays a plain data consumer.
  const qs = new URLSearchParams({
    client_id: props.clientId,
    redirect_uri: props.redirectUri,
    state: props.state,
    code_challenge: props.codeChallenge,
    code_challenge_method: props.codeChallengeMethod,
  });
  const sseUrl = `/oauth/authorize/qr?${qs.toString()}`;

  return (
    <Layout
      locale={locale}
      title={`${t("common.brandName")} — ${t("login.title")}`}
      scripts={props.scripts}
      css={baseCss + qrCss}
    >
      <main
        className="card"
        style={{ maxWidth: 480, textAlign: "center" }}
        data-island="qr-flow"
        data-auto="1"
        data-sse-url={sseUrl}
        data-cookie-url="/oauth/authorize/qr/cookie"
        data-password-url="/qr/password"
        data-msg-connected={t("login.connected")}
        data-msg-redirecting={t("common.redirecting")}
        data-msg-lost={t("login.connectionLost")}
      >
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <LanguageSwitcher current={locale} label={t("common.languageLabel")} />
        </div>
        <h1>{t("common.brandName")}</h1>
        <p className="muted">
          {clientName ? `${clientName} · ` : ""}
          {t("login.title")}
        </p>
        {/*
          Show the destination HOST, not only `clientName`: the name is chosen
          by whoever registered the client (registration is open, RFC 7591) and
          can say "Claude", while the host is where the authorization code is
          actually delivered and cannot be faked. Scanning the QR IS the consent
          action on this page, so the person scanning has to see who they are
          consenting to.
        */}
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          {/* `login.codeGoesTo` exists in all 20 catalogs; the `Messages` type is
              derived from messages/en.ts, so a missing locale is a build error. */}
          {t("login.codeGoesTo")} <strong>{destination}</strong>
        </p>

        <QrSection
          loadingText={t("login.connecting")}
          twoFactor={{
            title: t("twoFactor.title"),
            description: t("twoFactor.description"),
            passwordLabel: t("twoFactor.passwordLabel"),
            submit: t("twoFactor.submit"),
          }}
        />

        {/*
          Way in for directory reviewers, who cannot scan this code at all: they
          have no phone signed into the demo account. A line telling them to
          "open your review link first" was here before and was not enough — on
          2026-09-18 reviewers started from ChatGPT, sat on this page four times
          and rejected the app as "cannot connect". So the code is entered HERE,
          and the POST re-runs every OAuth check (see POST /oauth/authorize/review).

          A plain form on purpose: it works without the island, in any webview.
          English-only: it is addressed to a handful of reviewers, not users.
        */}
        <details id="review-code" style={{ marginTop: "1.5rem", textAlign: "start", fontSize: "0.9rem" }}>
          <summary style={{ cursor: "pointer" }}>Reviewing this app? Enter your review code</summary>
          <form method="post" action="/oauth/authorize/review" style={{ marginTop: 12 }}>
            <input type="hidden" name="client_id" value={props.clientId} />
            <input type="hidden" name="redirect_uri" value={props.redirectUri} />
            <input type="hidden" name="state" value={props.state} />
            <input type="hidden" name="code_challenge" value={props.codeChallenge} />
            <input type="hidden" name="code_challenge_method" value={props.codeChallengeMethod} />
            <label htmlFor="review-code-input" className="muted" style={{ display: "block", marginBottom: 6 }}>
              Paste the review code or the whole review link from the test instructions.
            </label>
            <input
              id="review-code-input"
              name="review_code"
              type="text"
              required
              autoComplete="off"
              spellCheck={false}
              style={{ display: "block", width: "100%", margin: "0 0 10px" }}
            />
            <button type="submit">Continue</button>
          </form>
        </details>
      </main>
    </Layout>
  );
}

export function render(props: AuthorizeProps): string {
  return `<!DOCTYPE html>${renderToString(<AuthorizePage {...props} />)}`;
}
