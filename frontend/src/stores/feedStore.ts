import { create } from 'zustand';
import { db } from '../utils/db';
import type { FeedLink, FeedSourceType } from '../types/feed';

interface FeedState {
  links: FeedLink[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** 某工序的全部投料笔次（含已撤回，按笔次排序） */
  linksOfBatch: (batchId: string) => FeedLink[];
  /** 某工序当前在投的笔次 */
  activeLinksOfBatch: (batchId: string) => FeedLink[];
  /** 某来源当前在投的笔次（药材删除校验等用） */
  activeLinksOfSource: (sourceType: FeedSourceType, sourceId: string) => FeedLink[];
  /** 某工序的在投合计（kg） */
  activeFeedKg: (batchId: string) => number;
  /** 某来源被各工序在投占用的合计（kg） */
  usedKgOf: (sourceType: FeedSourceType, sourceId: string) => number;
}

export const useFeedStore = create<FeedState>()((set, get) => ({
  links: [],
  hydrated: false,

  hydrate: async () => {
    const links = await db.feeds.orderBy('createdAt').toArray();
    set({ links, hydrated: true });
  },

  linksOfBatch: (batchId) =>
    get()
      .links.filter((l) => l.batchId === batchId)
      .sort((a, b) => a.seq - b.seq),

  activeLinksOfBatch: (batchId) =>
    get()
      .links.filter((l) => l.batchId === batchId && l.status === 'active')
      .sort((a, b) => a.seq - b.seq),

  activeLinksOfSource: (sourceType, sourceId) =>
    get().links.filter((l) => l.sourceType === sourceType && l.sourceId === sourceId && l.status === 'active'),

  activeFeedKg: (batchId) =>
    Number(
      get()
        .links.filter((l) => l.batchId === batchId && l.status === 'active')
        .reduce((sum, l) => sum + l.feedKg, 0)
        .toFixed(3),
    ),

  usedKgOf: (sourceType, sourceId) =>
    Number(
      get()
        .links.filter((l) => l.status === 'active' && l.sourceType === sourceType && l.sourceId === sourceId)
        .reduce((sum, l) => sum + l.feedKg, 0)
        .toFixed(3),
    ),
}));
