import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        "flex h-10 w-full rounded-[10px] px-4 py-3.5 text-[14px] text-[#e8edf5] transition-all placeholder:text-[rgba(255,255,255,0.25)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        "bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.14)]",
        "focus-visible:border-[rgba(249,115,22,0.4)] focus-visible:shadow-[0_0_0_3px_rgba(249,115,22,0.1)]",
        className
      )}
      ref={ref}
      {...props}
    />
  )
);
Input.displayName = "Input";

export { Input };
