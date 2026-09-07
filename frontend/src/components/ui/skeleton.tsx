import { cn } from '@/lib/utils';

/**
 * Shape only. A skeleton must never be mistaken for data, so it carries no
 * numerals and no text, and it is always accompanied by a line saying what
 * is loading (DESIGN_SYSTEM section 10, and the states rule in section 7).
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}

export { Skeleton };
