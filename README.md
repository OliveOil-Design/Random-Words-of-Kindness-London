# Kind Words, London

A QR-sticker kindness wall. Scan → read a random kind message left by a stranger → leave one for the next person. Every submission is checked by an LLM (any OpenAI-compatible endpoint) before it's published; anything the checker can't clear is held for a human, never auto-published.

```
kind-words/
├── index.html                          ← the page you deploy (fill in CONFIG)
└── supabase/
    ├── schema.sql                      ← run once in the SQL editor
    └── functions/submit/index.ts       ← moderation edge function
```

## How it fits together

- **Read** happens straight from the browser: a Postgres function returns one random *approved* message. Row Level Security means the anon key can only ever read approved rows.
- **Write** never touches the table directly. The browser posts the text to the `submit` edge function, which moderates it server-side (where the API keys live) and inserts it only if it passes. So no one can bypass moderation, even with the anon key.

## Setup (about 20 minutes)

### 1. Create the project
At [supabase.com](https://supabase.com), create a project. From **Settings → API**, note your **Project URL**, **anon public** key, and **service_role** key.

### 2. Create the table
Open **SQL Editor**, paste in `supabase/schema.sql`, run it. This creates the table, the security policies, the random-message function, and seven seed messages.

### 3. Deploy the moderation function
Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then:

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF

# point moderation at whichever provider you like (examples below)
supabase secrets set \
  MODERATION_BASE_URL="https://api.openai.com/v1" \
  MODERATION_API_KEY="sk-..." \
  MODERATION_MODEL="gpt-4o-mini" \
  RATE_LIMIT_SALT="$(openssl rand -hex 16)"

supabase functions deploy submit
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — you don't set those.

### 4. Wire up the page
Open `index.html`, fill in the `CONFIG` block near the bottom with your Project URL, anon key, and the submit URL (`https://YOUR-PROJECT-REF.supabase.co/functions/v1/submit`).

### 5. Deploy the page
Drag `index.html` onto [Netlify Drop](https://app.netlify.com/drop), or push to Vercel / Cloudflare Pages. You'll get a public URL.

### 6. Make the QR
Point any QR generator at that URL, print, stick. Done.

## Swapping moderation providers

Change three secrets, redeploy nothing else (`supabase secrets set ...` then it takes effect):

| Provider | `MODERATION_BASE_URL` | `MODERATION_MODEL` (example) |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| GreenPT | *(their base URL)* | *(their model id)* |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.1-8b-instant` |
| Together | `https://api.together.xyz/v1` | *(a chat model id)* |
| Anthropic (OpenAI-compat) | `https://api.anthropic.com/v1` | `claude-sonnet-4-6` |

Any endpoint that accepts `POST /chat/completions` in OpenAI's format works. **Local models** (Ollama / LM Studio at `http://localhost:11434/v1`) only work when the function can reach them — i.e. during local dev with `supabase functions serve`, not from the deployed cloud function, unless you expose them via a tunnel.

## Reviewing held messages

If the moderator is ever unreachable or returns something unparseable, the message is stored with `approved = false` so a person can decide. To see the queue:

```sql
select * from public.messages where approved = false order by created_at desc;
-- approve one:
update public.messages set approved = true where id = '...';
-- or remove it:
delete from public.messages where id = '...';
```

## Security notes

- The **anon key is meant to be public** — RLS is what protects the data, not key secrecy.
- The **service_role key never leaves the edge function**. Don't put it in `index.html`.
- Visitors can't insert directly; all writes go through moderation.
- On moderation failure the system **fails safe** (holds for review) rather than publishing.

## Reporting and rate limiting

Both are built in.

**Report** — every displayed message has a small "Report this" link. Tapping it pulls the message off the wall immediately (it stops being served) and adds it to the same review queue, where you can restore or delete it:

```sql
select * from public.messages where approved = false order by reports desc, created_at desc;
update public.messages set approved = true, reports = 0 where id = '...';  -- restore
delete from public.messages where id = '...';                              -- remove
```

Reporting hides first and asks questions later — kinder default for a public wall, and false flags are easy to undo.

**Rate limit** — the `submit` function allows **5 submissions per 15 minutes per IP** (tweak the two constants at the top of `index.ts`). It keys off a **salted hash of the IP, never the raw IP**, in the `submission_log` table, and prunes expired rows on every call — so there's no standing store of who submitted what. Set `RATE_LIMIT_SALT` to any long random string (the command above generates one).

## A note on privacy

Messages carry no names or accounts. The only thing resembling personal data is the transient, hashed, auto-pruned rate-limit entry. Keep a one-line visible notice about how messages are handled and reviewed — enough for a street test of user-submitted public content in the UK.
