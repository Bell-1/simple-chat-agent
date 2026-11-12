import "./App.css";
import { useEffect } from "react";
import { LoaderCircle } from "lucide-react";
import { Thread } from "@/components/thread";
import { LoginPage } from "@/components/auth/login";
import { useAuthStore } from "@/stores/auth";

function App() {
  const user = useAuthStore((s) => s.user);
  const initialized = useAuthStore((s) => s.initialized);
  const fetchMe = useAuthStore((s) => s.fetchMe);

  useEffect(() => {
    void fetchMe();
  }, [fetchMe]);

  if (!initialized) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <LoaderCircle className="size-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!user) return <LoginPage />;

  return <Thread />;
}

export default App;
