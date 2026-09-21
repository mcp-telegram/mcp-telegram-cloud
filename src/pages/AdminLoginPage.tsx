import type { FC } from "hono/jsx";

export const AdminLoginPage: FC<{ returnTo: string; error: boolean }> = ({ returnTo, error }) => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <title>Admin login</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
    </head>
    <body style="font-family: system-ui, sans-serif; max-width: 360px; margin: 80px auto; padding: 0 16px;">
      <h1 style="font-size: 20px;">Admin login</h1>
      {error && <p style="color: #E53935; font-size: 14px;">Wrong username or password.</p>}
      <form method="post" action={`/admin-login?returnTo=${encodeURIComponent(returnTo)}`}>
        <div style="margin-bottom: 12px;">
          <label style="display: block; font-size: 13px; margin-bottom: 4px;" for="username">
            Username
          </label>
          <input
            style="width: 100%; padding: 8px; box-sizing: border-box;"
            id="username"
            name="username"
            type="text"
            autocomplete="username"
            required
          />
        </div>
        <div style="margin-bottom: 16px;">
          <label style="display: block; font-size: 13px; margin-bottom: 4px;" for="password">
            Password
          </label>
          <input
            style="width: 100%; padding: 8px; box-sizing: border-box;"
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
          />
        </div>
        <button style="width: 100%; padding: 10px; cursor: pointer;" type="submit">
          Log in
        </button>
      </form>
    </body>
  </html>
);
