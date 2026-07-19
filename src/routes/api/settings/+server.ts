import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSnapshot, updateTripSettings } from '$lib/server/database';
import { settingsSchema } from '$lib/validation';

export const PUT: RequestHandler = async ({ request }) => {
  const input = settingsSchema.safeParse(await request.json());
  if (!input.success) error(400, input.error.issues[0]?.message);
  updateTripSettings(input.data);
  return json(getSnapshot());
};
