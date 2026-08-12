---
name: mailwizz-betkido-ops
description: "Use when operating, extending, or debugging the betkido.com MailWizz EMA 2.8.1 deployment - server/DB access, admin login recovery, the custom AI Copilot extension, theme customization, and the MailWizz extension-development pattern."
---

# betkido.com MailWizz operations

## Access
- SSH alias `mailwizz` (already configured) reaches the Ubuntu 24.04 VPS. App root: `/var/www/mailwizz` (nginx + PHP 8.2-FPM + MariaDB).
- DB: name `mailwizz`, user `mailwizz`, password `76eb407b6dccdd1a62851e3c1ada8be8`, table prefix `mw_`. Query via `ssh mailwizz "mysql -u mailwizz -p'...' mailwizz -e '...'"`.
- Backend admin login: `https://betkido.com/backend/index.php/guest/index/login`. Admin row lives in `mw_user` (table `mw_backend_user` does NOT exist in this MailWizz version - backend/admin users and customers are split into `mw_user` vs `mw_customer`).

## Recovering/resetting the admin password
Passwords are hashed with `Hautelook\Phpass\PasswordHash` (13 iterations, portable hashes) via MailWizz's `passwordHasher()` helper - not a plain bcrypt/password_hash() call, so you cannot use PHP's native `password_hash()`. To reset:
```
php -r '
require "/var/www/mailwizz/vendor/autoload.php";
use Hautelook\Phpass\PasswordHash;
$pass = "NewPass...";
$h = new PasswordHash(13, true);
$hash = $h->HashPassword($pass);
$pdo = new PDO("mysql:host=127.0.0.1;dbname=mailwizz;charset=utf8", "mailwizz", "<password>");
$pdo->prepare("UPDATE mw_user SET password = :h WHERE user_id = 2")->execute([":h" => $hash]);
'
```
Run this whole thing as ONE remote PHP invocation (not separate hash-then-UPDATE-via-bash-string steps) - interpolating a `$P$...`-style hash through an intermediate shell variable gets mangled because `$` triggers shell variable expansion. Verify the login for real afterward with a scripted curl flow (fetch login page -> extract the `csrf_token` hidden input, whose `value` attribute appears BEFORE the `name` attribute in the HTML so naive `name=... value=...`-ordered regexes fail -> POST `UserLogin[email]`/`UserLogin[password]`/`UserLogin[remember_me]` -> confirm a page fetched with the resulting cookie jar renders the real dashboard, not just that the POST returned a redirect).

## Theme / UI customization
MailWizz's `BackendSystemInit` auto-detects and injects (last in the cascade, priority -1000) two zero-code override files if present:
- `/var/www/mailwizz/backend/assets/css/style-custom.css` (global CSS override for every backend page)
- `/var/www/mailwizz/backend/assets/js/app-custom.js` (global JS)
This is the correct, non-invasive way to reskin the whole Bootstrap 3 / AdminLTE backend without touching any view or layout file - one CSS file overriding shared classes (`.box`, `.btn`, `.sidebar-menu`, `.table`, etc.) cascades everywhere. Already in place with a modern indigo/flat palette.

## The AI Copilot extension (apps/common/extensions/ai-copilot)
Built because the bundled official "AI Assistant" extension (apps/common/extensions/ai-assistant) is a bare OpenAI-only wrapper: hardcoded to api.openai.com via the Tectalic SDK, 3 fixed model names, no tool/function calling, no custom base URL, no live data access, no web search.

AI Copilot instead provides:
- Backend Settings page (`/backend/index.php/ai-copilot/settings`): base_url (any OpenAI-compatible endpoint), api_key, model (free text), web search provider (none/exa/parallel) + its key, and an enabled toggle. Persisted via MailWizz's generic option table (`ExtensionModel`/`OptionAttributes`, no dedicated DB table) under category `system.extension.ai-copilot.data`.
- A floating chat widget injected into every backend page footer via the `layout_footer_html` hook (same mechanism the official ai-assistant extension uses), only when the settings model's `getIsEnabled()` is true (enabled=yes AND base_url AND api_key present - a separate concern from the extension itself being framework-enabled via Extensions > Enable).
- Chat endpoint `/backend/index.php/ai-copilot/chat/send` (POST): runs an OpenAI-compatible tool-calling loop (max 6 rounds) with tools `list_campaigns`, `get_campaign_stats`, `list_lists`, `get_subscriber_count`, `list_delivery_servers`, `list_customers`, `create_delivery_server` (real write, creates a `DeliveryServerSmtp` AR record), and `web_search` (Exa `POST api.exa.ai/search` with `x-api-key`/`numResults`/`contents.highlights`, or Parallel `POST api.parallel.ai/v1beta/search` with `x-api-key` + `parallel-beta: search-extract-2025-10-10` headers and `objective`/`search_queries` body). Client is stateless server-side - the browser's `localStorage` holds the running message history and resends it each turn.
- CSRF gotcha: MailWizz's CSRF filter runs as a global `onBeginRequest` listener BEFORE any controller code executes (confirmed via the app's `application.log` stack trace through `CApplication::onBeginRequest` -> `CHttpRequest::validateCsrfToken`), so `$this->enableCsrfValidation = false;` set inside an action method is always too late. A raw JSON POST body also never populates `$_POST`, so Yii's own `$_POST[csrfTokenName]`-based check always fails for `fetch()` with `Content-Type: application/json`. Fix: send a normal `application/x-www-form-urlencoded` body with a real `csrf_token` field (grab the value from a `data-csrf` attribute rendered server-side via `request()->getCsrfToken()`) plus a `payload` field holding the JSON-encoded message/history; let Yii's native filter validate it, and read `request()->getPost('payload')` server-side instead of `php://input`.

### MailWizz extension-development pattern (generalizes beyond this one extension)
- Directory drop-in under `apps/common/extensions/<dir-name>/<DirName>Ext.php extends ExtensionInit`. `ExtensionsManager` auto-discovers every subdirectory - no manual registration file needed - but only calls `->run()` on extensions enabled via Extensions > Enable (`GET extensions/enable?id=<dir-name>`, framework-level flag stored at option category `system.extension.<dir-name>` key `status`).
- Settings models extend `ExtensionModel` (which extends `OptionAttributes`): declare plain public properties, `rules()`, `attributeLabels()`; `save()`/`refresh()` auto-persist/reload every public attribute to/from the option table via `getCategoryName()` (return `''` for a flat namespace) - no dedicated DB table or manual SQL needed unless you have genuinely relational settings data.
- The option table (`mw_option`) has a composite `(category, key)` primary key, NOT a single dotted string column - `WHERE key LIKE '%foo%'` will miss anything whose namespace lives in `category`; query `category LIKE '%foo%'` instead when hunting for an extension's stored options.
- Register backend routes/controllers unconditionally near the top of `run()` (so the settings page is reachable even while the feature itself is toggled off) via `$this->addUrlRules([...])` + `$this->addControllerMap([...])`; gate feature-activating hooks (widgets, filters that change behavior) behind your OWN settings model's enabled check, separate from the framework-level extension-enabled flag.
- `container()->add(Class::class, Class::class)` + `container()->get(Class::class)` is the DI pattern for singleton-per-request access to settings/common models.
- `httpClient(array $config = []): GuzzleHttp\Client` is the bundled helper for outbound HTTP (Guzzle 6.5.8 already in vendor/) - reuse it instead of instantiating a new client.
- `db(): CDbConnection` / `db()->createCommand($sql)->queryAll(true, [':param' => $value])` is the quickest path to read live data by table name (`{{table_name}}` maps to the `mw_` prefix automatically); ground-truth column names should come from `DESCRIBE mw_<table>` on the live DB, not assumption, before writing queries.
- After deploying/editing extension PHP files on the server, `php -l` each file, then `rm -rf /var/www/mailwizz/apps/common/runtime/assets/*` to force republish of any changed CSS/JS assets (MailWizz's `assetManager()->publish()` otherwise keeps serving the previously-published copy keyed by source mtime/hash).
- No local PHP CLI is available on the Windows workstation this project is developed from - lint and functional-test everything on the VPS itself (`ssh mailwizz "php -l ..."`), never assume local syntax checking is possible.
