import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn/ui's class merger: conditional classes, with later ones winning. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
