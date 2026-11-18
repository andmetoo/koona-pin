import { ButtonHTMLAttributes, forwardRef } from "react";

type Variant = "primary" | "secondary" | "outline" | "ghost" | "onDanger";
type Size = "md" | "lg";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-on-accent font-semibold hover:brightness-[0.94]",
  secondary: "bg-secondary text-ink hover:bg-secondary-hover",
  outline: "border border-border text-icon hover:bg-hover hover:text-ink",
  ghost: "text-muted hover:bg-hover hover:text-ink",
  onDanger: "bg-card text-on-danger-soft hover:brightness-[0.97]",
};
const sizes: Record<Size, string> = {
  md: "h-[30px] px-3",
  lg: "h-[34px] px-3.5",
};

/**
 * The 7 px corner, unless the caller's classes bring their own (2.25.2). Two `rounded-*` in one class list
 * don't override by their order there but by Tailwind's order in the CSS, where `rounded-md` beat
 * `rounded-lg`: reading mode drew 7 px beside the Aa button's 8.
 */
const corner = (className: string) => (/(^|\s)!?rounded(-|\s|$)/.test(className) ? "" : "rounded-md");

export const buttonClass = (variant: Variant = "secondary", size: Size = "md", radius = "rounded-md") =>
  `inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap ${radius} text-sm font-medium transition-[background-color,color,border-color,filter] duration-150 disabled:opacity-45 ${variants[variant]} ${sizes[size]}`;

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }
>(function Button({ variant, size, className = "", type = "button", ...props }, ref) {
  return <button ref={ref} type={type} className={`${buttonClass(variant, size, corner(className))} ${className}`} {...props} />;
});

/** A square button with an icon; the label is for screen readers and the hint. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: number }
>(function IconButton({ label, size = 30, className = "", type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      style={{ width: size, height: size }}
      className={`inline-flex shrink-0 items-center justify-center ${corner(className)} text-icon transition-[background-color,color] duration-150 hover:bg-hover hover:text-ink disabled:opacity-45 ${className}`}
      {...props}
    />
  );
});
