import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";

export type AvatarSize = "default" | "sm" | "lg";

export interface AvatarProps
  extends React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root> {
  size?: AvatarSize;
}

const sizeClass: Record<AvatarSize, string> = {
  default: "",
  sm: "contact-avatar--sm",
  lg: "contact-avatar--lg",
};

const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  AvatarProps
>(({ className, size = "default", ...props }, ref) => {
  const classes = ["contact-avatar", sizeClass[size], className]
    .filter(Boolean)
    .join(" ");
  return <AvatarPrimitive.Root ref={ref} className={classes} {...props} />;
});
Avatar.displayName = AvatarPrimitive.Root.displayName;

const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    className={["contact-avatar-image", className].filter(Boolean).join(" ")}
    {...props}
  />
));
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={["contact-avatar-fallback", className]
      .filter(Boolean)
      .join(" ")}
    {...props}
  />
));
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;

export { Avatar, AvatarImage, AvatarFallback };
