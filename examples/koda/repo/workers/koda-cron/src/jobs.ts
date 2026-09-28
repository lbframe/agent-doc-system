import { LESSON_PUBLISHED } from "@koda/lesson-canon";

export async function scheduled(event: { cron: string }) {
  return { subject: LESSON_PUBLISHED, cron: event.cron };
}
