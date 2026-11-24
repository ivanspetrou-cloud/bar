# Bar — события окон для таскбара: печатает "E" при открытии, закрытии, смене активного окна, сворачивании
# и смене заголовка верхнеуровневых окон. Сами данные (список окон) Bar запрашивает отдельно, только по событию.
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
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint msg; public IntPtr w; public IntPtr l; public uint time; public int x; public int y; }
    static WinEventProc keep; // не дать сборщику мусора удалить обработчик
    static long last;
    static void On(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
      if (idObject != 0 || idChild != 0 || hwnd == IntPtr.Zero) return;
      if (ev != 3 && GetAncestor(hwnd, 2) != hwnd) return; // только окна верхнего уровня
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
      MSG m; while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
    }
  }
}
'@
[BarWinEvents.Hook]::Run()
