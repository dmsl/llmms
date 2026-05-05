const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RESULTS_PER_SOURCE = 5;
const DEFAULT_MAX_RESULTS_TOTAL = 18;

const registeredProviders = [];

function timeoutSignal(ms = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timerId = window.setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cancel: () => window.clearTimeout(timerId)
  };
}

async function safeFetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  const { signal, cancel } = timeoutSignal(timeoutMs);
  try {
    const res = await fetch(url, {
      signal,
      headers: {
        Accept: 'application/json',
        ...headers
      }
    });
    if (!res.ok) {
      throw new Error(`${res.status} ${url}`);
    }
    return await res.json();
  } finally {
    cancel();
  }
}

function normalizeText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalizeUrl(url) {
  return String(url || '').split('#')[0].trim();
}

function normalize(items) {
  const seen = new Set();
  return (items || [])
    .filter(item => item?.url && item?.title)
    .filter(item => {
      const key = canonicalizeUrl(item.url).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function truncateSnippet(value, maxLen = 240) {
  const text = normalizeText(value);
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1).trim()}…`;
}

function isWeatherLikeQuery(query) {
  return /\b(weather|temperature|forecast|rain|raining|snow|wind|humidity|uv index|sunrise|sunset|climate)\b/i.test(String(query || ''));
}

function extractWeatherLocation(query) {
  const raw = String(query || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  const inMatch = lower.match(/\bin\s+([a-z][a-z\s,.'-]{1,80})$/i);
  let location = inMatch ? inMatch[1] : raw;
  location = location
    .replace(/\b(current|today|now|right now|please|weather|forecast|temperature|like|what(?:'s| is)|tell me|for)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,\s]+|[,\s]+$/g, '');
  return location;
}

function classifyQuery(query) {
  const text = String(query || '').toLowerCase();
  const categories = [];

  if (/\b(weather|temperature|forecast|rain|raining|snow|wind|humidity|uv index|sunrise|sunset|climate)\b/.test(text)) {
    categories.push('weather');
  }
  if (/\b(today|latest|recent|news|headline|breaking|current|now|this week|this month)\b/.test(text)) {
    categories.push('news');
  }
  if (/\b(paper|papers|research|study|studies|doi|arxiv|pubmed|journal|citation|abstract|academic|peer review|methodology)\b/.test(text)) {
    categories.push('academic');
  }
  if (/\b(code|bug|npm|package|library|javascript|typescript|python|react|vue|node|browser|frontend|backend|api|sdk|cli|git|docker|kubernetes)\b/.test(text)) {
    categories.push('tech');
  }

  if (categories.length === 0) {
    categories.push('general');
  }

  return {
    primary: categories[0],
    categories
  };
}

async function searchOpenMeteo(query, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const candidates = [];
  const extracted = extractWeatherLocation(query);
  if (extracted) candidates.push(extracted);
  candidates.push(String(query || '').trim());

  let location = null;
  for (const candidate of candidates.filter(Boolean)) {
    const geoUrl =
      'https://geocoding-api.open-meteo.com/v1/search' +
      `?name=${encodeURIComponent(candidate)}` +
      '&count=1&language=en&format=json';
    const geoData = await safeFetchJson(geoUrl, { timeoutMs });
    location = Array.isArray(geoData?.results) ? geoData.results[0] : null;
    if (location) break;
  }
  if (!location) return [];

  const lat = Number(location.latitude);
  const lon = Number(location.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];

  const weatherUrl =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat}` +
    `&longitude=${lon}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum' +
    '&timezone=auto&forecast_days=2';

  const weatherData = await safeFetchJson(weatherUrl, { timeoutMs });
  const current = weatherData?.current || {};
  const daily = weatherData?.daily || {};
  const today = Array.isArray(daily.time) && daily.time.length > 0 ? 0 : -1;
  const max = today >= 0 && Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[today] : null;
  const min = today >= 0 && Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[today] : null;
  const rain = today >= 0 && Array.isArray(daily.precipitation_sum) ? daily.precipitation_sum[today] : null;

  const summary = [
    Number.isFinite(current.temperature_2m) ? `Now ${current.temperature_2m}°C` : '',
    Number.isFinite(current.apparent_temperature) ? `feels like ${current.apparent_temperature}°C` : '',
    Number.isFinite(current.relative_humidity_2m) ? `humidity ${current.relative_humidity_2m}%` : '',
    Number.isFinite(current.wind_speed_10m) ? `wind ${current.wind_speed_10m} km/h` : '',
    Number.isFinite(max) && Number.isFinite(min) ? `today ${min}°C to ${max}°C` : '',
    Number.isFinite(rain) ? `rain ${rain} mm` : ''
  ].filter(Boolean).join(' · ');

  const place = [location.name, location.country].filter(Boolean).join(', ');
  return [
    {
      title: place ? `Current weather in ${place}` : 'Current weather',
      url: `https://open-meteo.com/en/docs`,
      snippet: truncateSnippet(summary),
      source: 'Open-Meteo'
    }
  ];
}

async function searchGDELT(query, { timeoutMs = DEFAULT_TIMEOUT_MS, limit = DEFAULT_MAX_RESULTS_PER_SOURCE } = {}) {
  const url =
    'https://api.gdeltproject.org/api/v2/doc/doc' +
    `?query=${encodeURIComponent(query)}` +
    '&mode=artlist' +
    '&format=json' +
    `&maxrecords=${Math.max(1, limit)}` +
    '&sort=hybridrel';

  const data = await safeFetchJson(url, { timeoutMs });
  return (data.articles || []).map(article => ({
    title: normalizeText(article.title),
    url: article.url,
    snippet: truncateSnippet([
      article.seendate ? `Seen ${article.seendate}` : '',
      article.sourceCountry || '',
      article.sourceCollection || ''
    ].filter(Boolean).join(' · ')),
    source: 'GDELT'
  }));
}

async function searchHN(query, { timeoutMs = DEFAULT_TIMEOUT_MS, limit = DEFAULT_MAX_RESULTS_PER_SOURCE } = {}) {
  const url =
    'https://hn.algolia.com/api/v1/search_by_date' +
    `?query=${encodeURIComponent(query)}` +
    '&tags=story' +
    `&hitsPerPage=${Math.max(1, limit)}`;

  const data = await safeFetchJson(url, { timeoutMs });
  return (data.hits || []).slice(0, limit).map(hit => ({
    title: normalizeText(hit.title || hit.story_title),
    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    snippet: truncateSnippet(`HN points: ${hit.points ?? 0} · comments: ${hit.num_comments ?? 0}`),
    source: 'Hacker News'
  }));
}

async function searchWikipedia(query, { timeoutMs = DEFAULT_TIMEOUT_MS, limit = DEFAULT_MAX_RESULTS_PER_SOURCE } = {}) {
  const url =
    'https://en.wikipedia.org/w/api.php' +
    '?action=query' +
    '&list=search' +
    '&format=json' +
    '&origin=*' +
    `&srlimit=${Math.max(1, limit)}` +
    `&srsearch=${encodeURIComponent(query)}`;

  const data = await safeFetchJson(url, { timeoutMs });
  return (data.query?.search || []).slice(0, limit).map(page => ({
    title: normalizeText(page.title),
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(page.title || '').replaceAll(' ', '_'))}`,
    snippet: truncateSnippet(page.snippet),
    source: 'Wikipedia'
  }));
}

async function searchWikidata(query, { timeoutMs = DEFAULT_TIMEOUT_MS, limit = DEFAULT_MAX_RESULTS_PER_SOURCE } = {}) {
  const sparql = `
    SELECT ?item ?itemLabel ?description WHERE {
      SERVICE wikibase:mwapi {
        bd:serviceParam wikibase:endpoint "www.wikidata.org";
                        wikibase:api "EntitySearch";
                        mwapi:search "${String(query).replaceAll('"', '\\"')}";
                        mwapi:language "en".
        ?item wikibase:apiOutputItem mwapi:item.
      }
      OPTIONAL {
        ?item schema:description ?description.
        FILTER(LANG(?description) = "en")
      }
      SERVICE wikibase:label {
        bd:serviceParam wikibase:language "en".
        ?item rdfs:label ?itemLabel.
      }
    }
    LIMIT ${Math.max(1, limit)}
  `;

  const url =
    'https://query.wikidata.org/sparql' +
    `?query=${encodeURIComponent(sparql)}` +
    '&format=json';

  const data = await safeFetchJson(url, {
    timeoutMs,
    headers: { 'Accept': 'application/sparql-results+json' }
  });

  return (data.results?.bindings || []).map(binding => ({
    title: normalizeText(binding.itemLabel?.value),
    url: binding.item?.value,
    snippet: truncateSnippet(binding.description?.value),
    source: 'Wikidata'
  }));
}

async function searchCrossref(query, { timeoutMs = DEFAULT_TIMEOUT_MS, limit = DEFAULT_MAX_RESULTS_PER_SOURCE } = {}) {
  const url =
    'https://api.crossref.org/works' +
    `?query=${encodeURIComponent(query)}` +
    `&rows=${Math.max(1, limit)}`;

  const data = await safeFetchJson(url, { timeoutMs });
  return (data.message?.items || []).map(work => ({
    title: normalizeText(work.title?.[0]),
    url: work.URL || (work.DOI ? `https://doi.org/${work.DOI}` : ''),
    snippet: truncateSnippet([
      work['container-title']?.[0],
      work.published?.['date-parts']?.[0]?.[0]
    ].filter(Boolean).join(' · ')),
    source: 'Crossref'
  }));
}

async function searchEuropePMC(query, { timeoutMs = DEFAULT_TIMEOUT_MS, limit = DEFAULT_MAX_RESULTS_PER_SOURCE } = {}) {
  const url =
    'https://www.ebi.ac.uk/europepmc/webservices/rest/search' +
    `?query=${encodeURIComponent(query)}` +
    '&format=json' +
    `&pageSize=${Math.max(1, limit)}`;

  const data = await safeFetchJson(url, { timeoutMs });
  return (data.resultList?.result || []).map(paper => ({
    title: normalizeText(paper.title),
    url: paper.doi
      ? `https://doi.org/${paper.doi}`
      : `https://europepmc.org/article/${paper.source}/${paper.id}`,
    snippet: truncateSnippet([
      paper.journalTitle,
      paper.pubYear
    ].filter(Boolean).join(' · ')),
    source: 'Europe PMC'
  }));
}

function registerSearchProvider(provider) {
  if (!provider?.id || typeof provider.search !== 'function') return;
  registeredProviders.push({
    limit: DEFAULT_MAX_RESULTS_PER_SOURCE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    category: 'general',
    enabled: true,
    ...provider
  });
}

function getRegisteredProviders() {
  return [...registeredProviders];
}

function getDefaultProviderSet() {
  return [
    {
      id: 'wikipedia',
      label: 'Wikipedia',
      category: 'general',
      search: searchWikipedia
    },
    {
      id: 'wikidata',
      label: 'Wikidata',
      category: 'general',
      search: searchWikidata
    },
    {
      id: 'crossref',
      label: 'Crossref',
      category: 'academic',
      search: searchCrossref
    },
    {
      id: 'europepmc',
      label: 'Europe PMC',
      category: 'academic',
      search: searchEuropePMC
    },
    {
      id: 'gdelt',
      label: 'GDELT',
      category: 'news',
      search: searchGDELT
    },
    {
      id: 'openmeteo',
      label: 'Open-Meteo',
      category: 'weather',
      search: searchOpenMeteo
    },
    {
      id: 'hn',
      label: 'Hacker News',
      category: 'tech',
      search: searchHN
    }
  ];
}

function getActiveProviders(query, { category, providers = [] } = {}) {
  const profile = classifyQuery(query);
  const providerList = providers.length > 0 ? providers : [...registeredProviders, ...getDefaultProviderSet()];
  const unique = new Map();

  for (const provider of providerList) {
    if (!provider?.id || unique.has(provider.id)) continue;
    unique.set(provider.id, provider);
  }

  const orderedProviders = [...unique.values()].filter(provider => provider.enabled !== false);

  const categoryPriority = [
    profile.primary,
    ...profile.categories.filter(item => item !== profile.primary),
    'general'
  ];

  const normalizedCategory = typeof category === 'string' ? category.trim().toLowerCase() : '';
  const targetCategory = normalizedCategory || profile.primary;
  return orderedProviders
    .filter(provider => {
      if (!targetCategory) return true;
      if (targetCategory === 'general') return true;
      return provider.category === targetCategory || provider.category === 'general';
    })
    .sort((left, right) => {
      const leftIdx = categoryPriority.indexOf(left.category);
      const rightIdx = categoryPriority.indexOf(right.category);
      const leftRank = leftIdx === -1 ? Number.MAX_SAFE_INTEGER : leftIdx;
      const rightRank = rightIdx === -1 ? Number.MAX_SAFE_INTEGER : rightIdx;
      return leftRank - rightRank;
    });
}

async function searchProvider(provider, query, options = {}) {
  try {
    const items = await provider.search(query, {
      timeoutMs: provider.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      limit: provider.limit ?? options.limit ?? DEFAULT_MAX_RESULTS_PER_SOURCE
    });
    return {
      id: provider.id,
      label: provider.label || provider.id,
      category: provider.category || 'general',
      ok: true,
      items: normalize(items).slice(0, provider.limit ?? options.limit ?? DEFAULT_MAX_RESULTS_PER_SOURCE)
    };
  } catch (error) {
    return {
      id: provider.id,
      label: provider.label || provider.id,
      category: provider.category || 'general',
      ok: false,
      error: error?.message || String(error),
      items: []
    };
  }
}

export async function gatherEvidence(query, options = {}) {
  const text = String(query || '').trim();
  if (!text) {
    return {
      query: text,
      category: 'general',
      items: [],
      sources: [],
      generatedAt: new Date().toISOString()
    };
  }

  const profile = classifyQuery(text);
  const forcedCategory = isWeatherLikeQuery(text) ? 'weather' : options.category;
  const providerBudget = Number.isFinite(options.providerBudget) ? Math.max(1, options.providerBudget) : 4;
  const totalLimit = Number.isFinite(options.totalLimit) ? Math.max(1, options.totalLimit) : DEFAULT_MAX_RESULTS_TOTAL;
  const providers = getActiveProviders(text, { ...options, category: forcedCategory }).slice(0, providerBudget);

  const settled = await Promise.all(
    providers.map(provider => searchProvider(provider, text, options))
  );

  const items = normalize(
    settled.flatMap(result => (result.items || []).map(item => ({
      ...item,
      sourceId: result.id,
      sourceCategory: result.category,
      sourceLabel: result.label
    })))
  ).slice(0, totalLimit);

  return {
    query: text,
    category: profile.primary,
    tags: profile.categories,
    items,
    sources: settled,
    generatedAt: new Date().toISOString()
  };
}

export function formatEvidenceContext(bundle, { maxItems = 12 } = {}) {
  const items = Array.isArray(bundle?.items) ? bundle.items.slice(0, maxItems) : [];
  if (items.length === 0) {
    return 'Web evidence: none found.';
  }

  const lines = ['Web evidence:'];
  items.forEach((item, index) => {
    const label = item.sourceLabel || item.source || 'Source';
    const snippet = truncateSnippet(item.snippet || '', 280);
    lines.push(`${index + 1}. [${label}] ${item.title}`);
    if (snippet) {
      lines.push(`   ${snippet}`);
    }
    if (item.url) {
      lines.push(`   ${item.url}`);
    }
  });
  return lines.join('\n');
}

export async function searchWeb(query, options = {}) {
  const bundle = await gatherEvidence(query, options);
  return bundle.items;
}

export {
  classifyQuery,
  registerSearchProvider,
  getRegisteredProviders,
  searchGDELT,
  searchHN,
  searchWikipedia,
  searchWikidata,
  searchCrossref,
  searchEuropePMC
};
