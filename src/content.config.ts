import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

export const CATEGORIES = {
  hushuabadao: '胡说八道',
  jiagou: '架构分析',
  chuangye: '创业鬼才',
} as const;

export type CategorySlug = keyof typeof CATEGORIES;

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    description: z.string().optional(),
    category: z.enum(['胡说八道', '架构分析', '创业鬼才']).optional(),
  }),
});

export const collections = { blog };
