import { getSearxngURL } from './config/serverRegistry';

interface SearxngSearchOptions {
  categories?: string[];
  engines?: string[];
  language?: string;
  pageno?: number;
}

interface SearxngSearchResult {
  title: string;
  url: string;
  img_src?: string;
  thumbnail_src?: string;
  thumbnail?: string;
  content?: string;
  author?: string;
  iframe_src?: string;
  score?: number;
  engine?: string;
  engines?: string[];
  parsed_url?: string[];
}

// Domain trust tiers for programming content
const HIGH_TRUST_DOMAINS = [
  'stackoverflow.com', 'stackexchange.com',
  'github.com', 'github.io',
  'developer.mozilla.org', 'docs.microsoft.com', 'learn.microsoft.com',
  'php.net', 'laravel.com', 'python.org', 'docs.python.org',
  'nodejs.org', 'typescriptlang.org', 'rust-lang.org', 'go.dev',
  'kotlinlang.org', 'ruby-lang.org', 'docs.oracle.com',
  'react.dev', 'vuejs.org', 'angular.dev', 'nextjs.org', 'svelte.dev',
  'tailwindcss.com', 'djangoproject.com', 'rubyonrails.org', 'spring.io',
  'docker.com', 'kubernetes.io',
];

const MEDIUM_TRUST_DOMAINS = [
  'dev.to', 'hashnode.dev', 'medium.com',
  'freecodecamp.org', 'digitalocean.com', 'baeldung.com',
  'geeksforgeeks.org', 'hackernoon.com',
  'css-tricks.com', 'smashingmagazine.com',
  'aws.amazon.com', 'cloud.google.com',
  'vercel.com', 'wikipedia.org', 'archlinux.org',
];

function getDomainTrustBoost(url: string): number {
  try {
    const hostname = new URL(url).hostname;
    if (HIGH_TRUST_DOMAINS.some((d) => hostname === d || hostname.endsWith('.' + d))) {
      return 2.0;
    }
    if (MEDIUM_TRUST_DOMAINS.some((d) => hostname === d || hostname.endsWith('.' + d))) {
      return 1.5;
    }
  } catch {}
  return 1.0;
}

export const searchSearxng = async (
  query: string,
  opts?: SearxngSearchOptions,
) => {
  const searxngURL = getSearxngURL();

  const url = new URL(`${searxngURL}/search?format=json`);
  url.searchParams.append('q', query);

  if (opts) {
    Object.keys(opts).forEach((key) => {
      const value = opts[key as keyof SearxngSearchOptions];
      if (Array.isArray(value)) {
        url.searchParams.append(key, value.join(','));
        return;
      }
      url.searchParams.append(key, value as string);
    });
  }

  const res = await fetch(url);
  const data = await res.json();

  const results: SearxngSearchResult[] = data.results;
  const suggestions: string[] = data.suggestions;

  // Sort results by SearxNG score * domain trust boost
  const rankedResults = results.sort((a, b) => {
    const scoreA = (a.score ?? 0) * getDomainTrustBoost(a.url);
    const scoreB = (b.score ?? 0) * getDomainTrustBoost(b.url);
    return scoreB - scoreA;
  });

  return { results: rankedResults, suggestions };
};
