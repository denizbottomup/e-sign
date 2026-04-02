import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-[20px] border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[rgba(249,115,22,0.15)] text-[#F97316]",
        secondary: "border-transparent bg-[rgba(255,255,255,0.07)] text-[rgba(255,255,255,0.65)]",
        destructive: "border-transparent bg-[rgba(239,68,68,0.15)] text-[#EF4444]",
        outline: "text-[rgba(255,255,255,0.65)] border-[rgba(255,255,255,0.14)]",
        success: "border-transparent bg-[rgba(45,199,113,0.15)] text-[#2DC771]",
        warning: "border-transparent bg-[rgba(245,200,66,0.15)] text-[#F5C842]",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
