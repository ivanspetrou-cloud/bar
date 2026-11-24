# Bar — события окон для таскбара: печатает "E" при открытии, закрытии, смене активного окна, сворачивании
# и смене заголовка верхнеуровневых окон. Сами данные (список окон) Bar запрашивает отдельно, только по событию.
# В момент сворачивания окно ещё нарисовано — снимаем его здесь же и печатаем "T <окно> <jpeg base64>":
# так у свёрнутых окон в превью таскбара остаётся картинка, а не пустое место.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace BarWinEvents {
  public static class Hook {
    delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    static long lastL;
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int l, t, r, b; }
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint msg; public IntPtr w; public IntPtr l; public uint time; public int x; public int y; }
    static WinEventProc keep; // не дать сборщику мусора удалить обработчик
    static long last;

    static string Thumb(IntPtr h, int maxW, int maxH) {
      try {
        RECT r; GetWindowRect(h, out r);
        int w = r.r - r.l, hh = r.b - r.t;
        if (r.l <= -30000 || w < 200 || hh < 100 || w > 10000 || hh > 10000) return ""; // уже свёрнуто — поздно
        using (var bmp = new System.Drawing.Bitmap(w, hh, System.Drawing.Imaging.PixelFormat.Format32bppArgb)) {
          using (var g = System.Drawing.Graphics.FromImage(bmp)) { var hdc = g.GetHdc(); bool ok = PrintWindow(h, hdc, 2); g.ReleaseHdc(hdc); if (!ok) return ""; }
          double k = Math.Min(1.0, Math.Min((double)maxW / w, (double)maxH / hh));
          int tw = Math.Max(1, (int)(w * k)), th = Math.Max(1, (int)(hh * k));
          using (var sm = new System.Drawing.Bitmap(tw, th))
          using (var g2 = System.Drawing.Graphics.FromImage(sm))
          using (var ms = new System.IO.MemoryStream()) {
            g2.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            g2.DrawImage(bmp, 0, 0, tw, th);
            var enc = Array.Find(System.Drawing.Imaging.ImageCodecInfo.GetImageEncoders(), (c) => c.MimeType == "image/jpeg");
            var ep = new System.Drawing.Imaging.EncoderParameters(1);
            ep.Param[0] = new System.Drawing.Imaging.EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 90L);
            sm.Save(ms, enc, ep);
            return Convert.ToBase64String(ms.ToArray());
          }
        }
      } catch { return ""; }
    }

    static void On(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
      if (idObject != 0 || idChild != 0 || hwnd == IntPtr.Zero) return;
      if (ev != 3 && GetAncestor(hwnd, 2) != hwnd) return; // только окна верхнего уровня
      if (ev == 0x800B) { // размер / место — только у активного окна и не чаще ~3 раз в секунду
        if (hwnd != GetForegroundWindow()) return;
        long n = Environment.TickCount; if (n - lastL < 300) return; lastL = n;
        Console.Out.WriteLine("L"); Console.Out.Flush(); return;
      }
      if (ev == 0x16) { var t = Thumb(hwnd, 720, 450); if (t.Length > 0) { Console.Out.WriteLine("T " + hwnd.ToInt64() + " " + t); Console.Out.Flush(); } }
      long now = Environment.TickCount;
      if (ev == 0x800C && now - last < 400) return; // заголовки браузеров меняются часто — не чаще 2,5 раза в секунду
      last = now;
      Console.Out.WriteLine("E"); Console.Out.Flush();
    }
    public static void Run() {
      keep = On;
      SetWinEventHook(0x0003, 0x0003, IntPtr.Zero, keep, 0, 0, 2);   // активное окно
      SetWinEventHook(0x0016, 0x0017, IntPtr.Zero, keep, 0, 0, 2);   // свернуть / развернуть
      SetWinEventHook(0x8001, 0x8003, IntPtr.Zero, keep, 0, 0, 2);   // уничтожено, показано, скрыто
      SetWinEventHook(0x800C, 0x800C, IntPtr.Zero, keep, 0, 0, 2);   // заголовок
      SetWinEventHook(0x800B, 0x800B, IntPtr.Zero, keep, 0, 0, 2);   // размер / место (развернули окно)
      MSG m; while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
    }
  }
}
'@ -ReferencedAssemblies System.Drawing
[Console]::OutputEncoding = [Text.Encoding]::ASCII
[BarWinEvents.Hook]::Run()
