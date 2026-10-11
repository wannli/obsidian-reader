import type { HttpGet, HttpResponse } from '../src/types';
export const sampleBody = `There is a particular kind of quiet that arrives when you stop collecting things to read and begin reading one of them.

Not everything needs to become a task. An article can be a small room you enter, spend some time in, and leave with a single thought worth keeping.

## One thing at a time

The tools we use shape the attention we bring to them. A crowded reading list asks us to manage a collection. A clear page asks us to consider an idea.

A highlight is a small act of recognition. It says: this mattered to me, here, today.

There is no need to explain it immediately. No need to turn it into a project, add a tag, or file it in precisely the right place. The passage and its source are enough.

## Keep what matters

Read slowly enough to notice the sentence that makes you pause. Select it. Let the rest of the article remain where it belongs, around the thought that caught your attention.

Later, when you return to this article, that thought will still be highlighted in its original context.

> A useful reading system is one that eventually gets out of the way.

The original text remains yours to read offline. The highlight is ordinary Markdown. Neither depends on keeping this particular reading interface forever.

[A related article](https://reader.test/linked-article)
`;
const webText = 'Reading is an encounter with an idea. A quiet page gives that encounter a little room. We can save a passage without building an elaborate system around it. ';
export const fixtureGet: HttpGet = async (url, headers): Promise<HttpResponse> => {
  if (url.startsWith('https://reader.test/')) {
    if (url.includes('error')) return { status: 503, text: 'Temporarily unavailable', headers: {} };
    if (url.endsWith('feed.xml')) return { status: 200, headers: { 'content-type': 'application/rss+xml', etag: 'fixture-v1' }, text: '<rss version="2.0"><channel><title>Quiet Pages</title><item><guid>web-1</guid><title>A smaller reading practice</title><link>https://reader.test/article</link></item></channel></rss>' };
    return { status: 200, headers: { 'content-type': 'text/html' }, text: '<!doctype html><html><head><title>A smaller reading practice</title></head><body><article><h1>A smaller reading practice</h1><p>' + webText.repeat(5) + '</p><h2>Start with one page</h2><p>' + webText.repeat(4) + '</p></article></body></html>' };
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  return { status: response.status, text: await response.text(), headers: Object.fromEntries(response.headers.entries()), url: response.url };
};
