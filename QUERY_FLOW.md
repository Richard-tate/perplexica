# Perplexica Query Flow

How a user search query is handled from request to final response.

---

## Architecture Overview

```
User submits query
        ↓
    POST /api/search
        ↓
    Load LLM + Embeddings from ModelRegistry
        ↓
    Create SessionManager + APISearchAgent
        ↓
    CLASSIFIER → RESEARCHER → WRITER → Streamed Response
```

The LLM provider (e.g. MiniMax) **does not call SearxNG directly**. Instead:

1. **SearxNG** handles web searching (`src/lib/searxng.ts`)
2. **LLM providers** handle reasoning, tool calling, and response generation
3. **The Search Agent** orchestrates both — uses the LLM to decide _what_ to search, calls SearxNG to _execute_ the search, then uses the LLM again to _synthesize_ the answer

---

## Step 1: API Entry Point

**File:** `src/app/api/search/route.ts`

The request enters via HTTP POST at `/api/search`.

### Request Body

```typescript
{
  optimizationMode: 'speed' | 'balanced' | 'quality',
  sources: ['web', 'discussions', 'academic'],
  chatModel: { providerId, key },
  embeddingModel: { providerId, key },
  query: string,
  history: [["role", "content"], ...],
  stream?: boolean,
  systemInstructions?: string
}
```

### What Happens

- Validates request has `sources` and `query`
- Loads chat and embedding models from the provider registry
- Converts chat history to typed messages
- Creates a `SessionManager` to track the entire search session
- Creates an `APISearchAgent` and calls `searchAsync()` asynchronously

### Response Modes

- `stream: false` → waits for completion, returns JSON `{ message, sources }`
- `stream: true` → uses `ReadableStream` to emit real-time updates as `text/event-stream`

---

## Step 2: Classifier

**File:** `src/lib/agents/search/classifier.ts`

Uses `llm.generateObject()` to determine what type of search is needed.

### Decision Points

```typescript
{
  classification: {
    skipSearch: boolean,            // Can answer without web search?
    personalSearch: boolean,        // Search user-uploaded files?
    academicSearch: boolean,        // Include academic databases?
    discussionSearch: boolean,      // Include Reddit/forums?
    showWeatherWidget: boolean,     // Show weather widget?
    showStockWidget: boolean,       // Show stock widget?
    showCalculationWidget: boolean  // Show calculator widget?
  },
  standaloneFollowUp: string        // Reworded standalone question
}
```

### Example

For _"Explain the Repository Pattern in Laravel"_:
- `skipSearch: false` — needs web results
- `academicSearch: false` — not an academic topic
- `discussionSearch: false` — not looking for forum opinions
- `standaloneFollowUp: "Explain the Repository Pattern in Laravel including what problem it solves, how it differs from Service Layers, a practical code example showing Controller → Service → Repository → Model, and when to use it vs when not to use it"`

---

## Step 3: Researcher (Multi-Turn Tool Loop)

**File:** `src/lib/agents/search/researcher/index.ts`

This is the core agentic loop. The LLM orchestrates multiple tool calls iteratively.

### Iteration Limits by Mode

| Mode | Max Iterations |
|------|---------------|
| speed | 2 |
| balanced | 6 |
| quality | 25 |

### Available Tools

| Tool | Description |
|------|-------------|
| `web_search` | General web search via SearxNG |
| `academic_search` | Search arxiv, Google Scholar, PubMed via SearxNG |
| `social_search` | Search Reddit/forums via SearxNG |
| `scrape_url` | Fetch and extract content from specific URLs |
| `uploads_search` | Search user-uploaded documents via embeddings |
| `__reasoning_preamble` | Show agent's reasoning/plan (balanced + quality only) |
| `done` | Signal research is complete |

### The Loop

```
Iteration 1:
  ┌─────────────────────────────────────────────┐
  │ Messages sent to LLM:                       │
  │   system: researcher prompt + tool list      │
  │   user:   standalone question                │
  └──────────────────┬──────────────────────────┘
                     ↓
  LLM responds with tool calls:
    web_search({ queries: ["query 1", "query 2", "query 3"] })
                     ↓
  Tool execution (all queries hit SearxNG in parallel):
    GET http://localhost:8080/search?format=json&q=query+1
    GET http://localhost:8080/search?format=json&q=query+2
    GET http://localhost:8080/search?format=json&q=query+3
                     ↓
  Results added back to message history as tool role

Iteration 2:
  ┌─────────────────────────────────────────────┐
  │ Messages sent to LLM:                       │
  │   system:    researcher prompt               │
  │   user:      standalone question             │
  │   assistant: { tool_calls: [...] }           │
  │   tool:      { search results JSON }         │
  └──────────────────┬──────────────────────────┘
                     ↓
  LLM sees results and decides:
    - Need more info? → call web_search/scrape_url again
    - Have enough?    → call done() → exit loop
```

### Message History Example

```json
[
  {
    "role": "user",
    "content": "Explain the Repository Pattern in Laravel..."
  },
  {
    "role": "assistant",
    "tool_calls": [
      {
        "id": "tc_abc123",
        "name": "web_search",
        "arguments": {
          "queries": [
            "Repository Pattern Laravel what problem it solves",
            "Laravel Repository Pattern vs Service Layer differences",
            "Laravel Controller Service Repository Model code example"
          ]
        }
      }
    ]
  },
  {
    "role": "tool",
    "id": "tc_abc123",
    "name": "web_search",
    "content": "{\"type\":\"search_results\",\"results\":[{\"content\":\"The Repository Pattern abstracts data access...\",\"metadata\":{\"title\":\"...\",\"url\":\"https://...\"}}]}"
  },
  {
    "role": "assistant",
    "tool_calls": [
      { "id": "tc_def456", "name": "done", "arguments": {} }
    ]
  },
  {
    "role": "tool",
    "id": "tc_def456",
    "name": "done",
    "content": "{\"type\":\"done\"}"
  }
]
```

### Post-Loop Processing

After the loop exits, results are filtered and deduplicated by URL. Duplicate URLs have their content merged. Final sources are emitted to the UI.

---

## Step 4: SearxNG Web Search

**File:** `src/lib/searxng.ts`

The actual web search is performed by SearxNG, a meta-search engine.

```typescript
searchSearxng(query, opts?)
  → GET {SEARXNG_URL}/search?format=json&q={query}
  → returns { results: SearxngSearchResult[], suggestions: string[] }
```

### Search Variants

| Action | SearxNG Engines |
|--------|----------------|
| `web_search` | All engines (default) |
| `social_search` | `engines: ['reddit']` |
| `academic_search` | `engines: ['arxiv', 'google scholar', 'pubmed']` |

### Configuration

- Environment variable: `SEARXNG_API_URL` (default: `http://localhost:8080`)
- Runs as a Docker service alongside the app

---

## Step 5: Writer (Final Answer Generation)

**File:** `src/lib/agents/search/index.ts` (lines ~101-166)

A separate LLM call (no tools) generates the final answer.

### Context Assembly

All search results are wrapped in XML:

```xml
<search_results>
  <result index=1 title="Repository Pattern in Laravel">
    The Repository Pattern abstracts data access...
  </result>
  <result index=2 title="Service Layer vs Repository">
    While a Service Layer handles business logic...
  </result>
</search_results>

<widgets_result>
  (weather, stocks, calculator outputs if applicable)
</widgets_result>
```

### Writer Prompt Rules

- Create informative, well-structured responses with Markdown
- Use inline citations with `[number]` notation
- EVERY sentence must cite a source
- Quality mode: must be 2000+ words

### Streaming

Response chunks are streamed back to the client in real-time via SSE events.

---

## Session Events

Throughout the flow, the `SessionManager` emits events:

| Event | Purpose |
|-------|---------|
| `block` (type: research) | Research progress with sub-steps |
| `block` (type: source) | Final source citations |
| `block` (type: text) | Answer text chunks |
| `end` | Search complete |
| `error` | Something failed |

---

## LLM Method Usage by Step

| Step | LLM Method | Tools? | Why It Matters |
|------|-----------|--------|----------------|
| Classifier | `generateObject()` | No | Must return valid structured JSON |
| Researcher | `streamText()` | **Yes** | Must handle multi-turn tool calls + IDs |
| Writer | `streamText()` | No | Basic streaming text generation |

The **Researcher step is the critical one** for LLM provider compatibility — the model must:

1. Decide which tools to call from the available set
2. Return properly formatted tool calls with valid IDs
3. Accept tool results back and reason about them
4. Know when to call `done` to stop the loop

---

## Key Files

| File | Purpose |
|------|---------|
| `src/app/api/search/route.ts` | HTTP entry point |
| `src/lib/agents/search/index.ts` | Top-level search orchestration |
| `src/lib/agents/search/api.ts` | API-specific search agent |
| `src/lib/agents/search/classifier.ts` | Query classification |
| `src/lib/agents/search/researcher/index.ts` | Multi-turn research loop |
| `src/lib/agents/search/researcher/actions/webSearch.ts` | Web search action (SearxNG) |
| `src/lib/agents/search/researcher/actions/registry.ts` | Tool/action registry |
| `src/lib/searxng.ts` | SearxNG HTTP client |
| `src/lib/prompts/search/writer.ts` | Writer prompt template |
| `src/lib/prompts/search/classifier.ts` | Classifier prompt template |
| `src/lib/models/registry.ts` | LLM provider loading |
| `src/lib/models/providers/index.ts` | Provider exports |
| `src/lib/session.ts` | Session event management |
