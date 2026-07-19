import { load as parseHTML } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters } from '@libs/filterInputs';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';
import { storage } from '@libs/storage';

type KJChapter = {
  id: string;
  number: number;
  slug: string;
  title: string;
  publishedAt: string;
  publishStatus: string;
  views: number;
  isLocked: boolean;
};

class KJNovelsPlugin implements Plugin.PluginBase {
  id = 'kjnovels';
  name = 'KJNovels';
  icon = 'src/en/kjnovels/icon.png';
  site = 'https://kjnovels.com';
  version = '1.0.0';
  filters: Filters | undefined = undefined;
  imageRequestInit?: Plugin.ImageRequestInit | undefined = undefined;

  webStorageUtilized?: boolean;

  hideLocked = storage.get('hideLocked');
  pluginSettings = {
    hideLocked: {
      value: '',
      label: 'Hide locked chapters',
      type: 'Switch',
    },
  };

  private headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    Referer: this.site,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    RSC: '1',
  };

  private async fetchRsc(url: string): Promise<string> {
    const res = await fetchApi(url, { headers: this.headers });
    return await res.text();
  }

  private extractDeferredText(rscText: string, refId: string): string {
    const match = new RegExp(`(?:^|\\n)${refId}:T([0-9a-f]+),`).exec(rscText);
    if (!match) {
      throw new Error('Could not locate chapter content in server response');
    }
    const start = match.index + match[0].length;
    const byteLength = parseInt(match[1], 16);
    const rest = rscText.slice(start);
    const bytes = new TextEncoder().encode(rest).slice(0, byteLength);
    return new TextDecoder().decode(bytes);
  }

  private extractJsonArray<T>(rscText: string, marker: string): T[] {
    const markerIndex = rscText.indexOf(marker);
    if (markerIndex === -1) {
      throw new Error('Could not locate expected data in server response');
    }
    const start = markerIndex + marker.length - 1;

    let depth = 0;
    let inString = false;
    let end = start;
    for (; end < rscText.length; end++) {
      const ch = rscText[end];
      if (inString) {
        if (ch === '\\') {
          end++;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '[') {
        depth++;
      } else if (ch === ']') {
        depth--;
        if (depth === 0) {
          end++;
          break;
        }
      }
    }

    return JSON.parse(rscText.slice(start, end)) as T[];
  }

  private async fetchAllNovels(): Promise<Plugin.NovelItem[]> {
    const rscText = await this.fetchRsc(`${this.site}/browse`);
    const novelRegex =
      /"href":"(\/novel\/[^"]+)","prefetch":false,"className":"block","children":\[[\s\S]*?"src":"([^"]+)"[\s\S]*?"alt":"([^"]+)"/g;

    const novels: Plugin.NovelItem[] = [];
    let match: RegExpExecArray | null;
    while ((match = novelRegex.exec(rscText)) !== null) {
      const [, path, cover, name] = match;
      novels.push({ name, path, cover: cover || defaultCover });
    }

    return novels;
  }

  async popularNovels(pageNo: number): Promise<Plugin.NovelItem[]> {
    if (pageNo !== 1) return [];
    return this.fetchAllNovels();
  }

  private static readonly statusMap: Record<string, string> = {
    ONGOING: NovelStatus.Ongoing,
    COMPLETED: NovelStatus.Completed,
    HIATUS: NovelStatus.OnHiatus,
    DROPPED: NovelStatus.Cancelled,
  };

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const rscText = await this.fetchRsc(`${this.site}${novelPath}`);

    const name =
      /"h1",null,\{"className":"text-3xl md:text-4xl font-bold mb-2","children":"([^"]+)"/.exec(
        rscText,
      )?.[1] || 'Untitled';

    const author =
      /"className":"font-medium text-foreground","children":"([^"]+)"/.exec(
        rscText,
      )?.[1];

    const cover =
      /"\$L43",null,\{"src":"([^"]+)","alt":"[^"]*Cover Image"/.exec(
        rscText,
      )?.[1];

    const statusKey = /"children":"(ONGOING|COMPLETED|HIATUS|DROPPED)"/.exec(
      rscText,
    )?.[1];

    const synopsisMatch = /"\$L47",null,\{"synopsis":"((?:[^"\\]|\\.)*)"/.exec(
      rscText,
    );
    const summary = synopsisMatch
      ? parseHTML(JSON.parse(`"${synopsisMatch[1]}"`) as string)
          .text()
          .trim()
      : undefined;

    const genres: string[] = [];
    const genreRegex =
      /"href":"\/browse\?genre=[^"]+","children":\[[\s\S]*?"children":"([^"]+)"/g;
    let genreMatch: RegExpExecArray | null;
    while ((genreMatch = genreRegex.exec(rscText)) !== null) {
      genres.push(genreMatch[1]);
    }

    const chapters = this.extractJsonArray<KJChapter>(rscText, '"chapters":[');

    return {
      path: novelPath,
      name,
      cover: cover || defaultCover,
      author,
      genres: genres.join(', '),
      summary,
      status:
        (statusKey && KJNovelsPlugin.statusMap[statusKey]) ||
        NovelStatus.Unknown,
      chapters: chapters
        .slice()
        .sort((a, b) => a.number - b.number)
        .filter(chapter => !(chapter.isLocked && this.hideLocked))
        .map(chapter => ({
          name: chapter.isLocked ? `🔒 ${chapter.title}` : chapter.title,
          path: `${novelPath}/${chapter.slug}`,
          chapterNumber: chapter.number,
          releaseTime: chapter.publishedAt.replace(/^\$D/, ''),
        })),
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const rscText = await this.fetchRsc(`${this.site}${chapterPath}`);

    const wrapperMatch =
      /"chapterTitle":"[^"]*","content":"((?:[^"\\]|\\.)*)","wordCount":\d+,"publishedAt":"[^"]*","initialProgress":[0-9.]+,"userId":"[^"]*","username":"[^"]*","isGatedContent":(true|false)/.exec(
        rscText,
      );
    if (!wrapperMatch) {
      throw new Error('Could not locate chapter content in server response');
    }

    const [, rawContent, isGatedContent] = wrapperMatch;
    if (isGatedContent === 'true') {
      throw new Error(
        'This chapter requires premium access and cannot be read here.',
      );
    }

    const content = JSON.parse(`"${rawContent}"`) as string;

    const refMatch = /^\$([0-9a-zA-Z]+)$/.exec(content);
    if (!refMatch) {
      // Content was inlined directly rather than streamed separately.
      return content;
    }

    return this.extractDeferredText(rscText, refMatch[1]);
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo !== 1) return [];

    const novels = await this.fetchAllNovels();
    const term = searchTerm.toLowerCase();

    return novels.filter(novel => novel.name.toLowerCase().includes(term));
  }

  resolveUrl = (path: string) => this.site + path;
}

export default new KJNovelsPlugin();
