import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] text-[13px] font-semibold transition-all focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
  {
    variants: {
      variant: {
        default: "gradient-btn text-white shadow-[0_4px_20px_rgba(249,115,22,0.3)] hover:shadow-[0_4px_24px_rgba(249,115,22,0.4)]",
        destructive: "bg-destructive text-white shadow-sm hover:bg-destructive/90",
        outline: "border text-[rgba(255,255,255,0.55)] bg-transparent hover:bg-[rgba(255,255,255,0.04)] hover:text-[#e8edf5]",
        secondary: "bg-[rgba(255,255,255,0.04)] text-[#e8edf5] hover:bg-[rgba(255,255,255,0.07)]",
        ghost: "hover:bg-[rgba(255,255,255,0.04)] text-[rgba(255,255,255,0.55)] hover:text-[#e8edf5]",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-7 rounded-md px-3 text-[12px]",
        lg: "h-10 rounded-[10px] px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
