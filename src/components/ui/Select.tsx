import React, { forwardRef } from "react";
import styles from "@/styles/components/ui/Input.module.css";

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  className?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className = "", children, ...props }, ref) => {
    return (
      <select ref={ref} className={`${styles.select} ${className}`.trim()} {...props}>
        {children}
      </select>
    );
  }
);
Select.displayName = "Select";
