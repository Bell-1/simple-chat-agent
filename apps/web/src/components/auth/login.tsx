import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { LangGraphLogoSVG } from "@/components/icons/langgraph";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/utils";

type Mode = "login" | "register";

/** 未登录时的入口页：邮箱 + 密码，注册后自动登录。 */
export function LoginPage() {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const submitting = useAuthStore((s) => s.submitting);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      if (mode === "login") {
        await login({ email, password });
      } else {
        await register({ email, password, name: name || undefined });
      }
      toast.success(mode === "login" ? "登录成功" : "注册成功");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    }
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-gradient-to-br from-slate-50 via-white to-emerald-50/40 p-4">
      <Card className="w-full max-w-md border-none shadow-xl">
        <CardHeader className="gap-3 pb-2">
          <div className="flex items-center gap-3">
            <LangGraphLogoSVG className="h-8" />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                Agent Chat
              </h1>
              <p className="text-sm text-muted-foreground">
                {mode === "login"
                  ? "登录后继续你的对话与资料"
                  : "创建账号，开始使用智能助手"}
              </p>
            </div>
          </div>

          <div className="mt-2 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
            {(["login", "register"] as Mode[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  mode === item
                    ? "bg-white text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item === "login" ? "登录" : "注册"}
              </button>
            ))}
          </div>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {mode === "register" && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="name">昵称</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="怎么称呼你（可选）"
                  autoComplete="nickname"
                />
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="email">邮箱</Label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password">密码</Label>
              <PasswordInput
                id="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 6 位"
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
              />
            </div>

            <Button
              type="submit"
              size="lg"
              className="mt-2 w-full"
              disabled={submitting}
            >
              {submitting && <LoaderCircle className="size-4 animate-spin" />}
              {mode === "login" ? "登录" : "注册并登录"}
            </Button>
          </form>

          <p className="mt-4 text-center text-xs text-muted-foreground">
            登录状态保存在 HttpOnly Cookie 中，有效期 30 天
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
