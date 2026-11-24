# Bar — уровень звука на выходе для «живого» эквалайзера. Печатает "M <пик 0..1>" ~20 раз в секунду.
# Пик — максимум по ВСЕМ активным устройствам вывода: музыка может идти не в устройство «по умолчанию»
# (у гарнитур вроде Arctis Nova — отдельные Game и Chat, у Sonar — виртуальные устройства).
# Только чтение пикового уровня из Windows (IAudioMeterInformation): ни звука, ни данных наружу.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace BarMeter {
  [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioMeterInformation { int GetPeakValue(out float pfPeak); }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid id, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface); }
  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection { int GetCount(out uint n); int Item(uint i, out IMMDevice d); }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices); }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
  public static class Meter {
    static List<IAudioMeterInformation> Meters() {
      var res = new List<IAudioMeterInformation>();
      try {
        var en = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
        IMMDeviceCollection col; Marshal.ThrowExceptionForHR(en.EnumAudioEndpoints(0, 1, out col)); // вывод, только активные
        uint n; col.GetCount(out n);
        for (uint i = 0; i < n; i++) {
          try {
            IMMDevice dev; col.Item(i, out dev);
            Guid iid = typeof(IAudioMeterInformation).GUID; object o;
            if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) == 0) res.Add((IAudioMeterInformation)o);
          } catch { }
        }
      } catch { }
      return res;
    }
    public static void Run(int stepMs) {
      var inv = System.Globalization.CultureInfo.InvariantCulture;
      var sw = Stopwatch.StartNew();
      List<IAudioMeterInformation> meters = null; long at = 0;
      while (true) {
        if (meters == null || sw.ElapsedMilliseconds - at > 3000) { meters = Meters(); at = sw.ElapsedMilliseconds; } // устройства могли подключить или сменить
        float best = 0;
        foreach (var m in meters) { try { float p; if (m.GetPeakValue(out p) == 0 && p > best) best = p; } catch { } }
        Console.Out.WriteLine("M " + Math.Round(best, 3).ToString(inv));
        Console.Out.Flush();
        Thread.Sleep(stepMs);
      }
    }
  }
}
'@
[BarMeter.Meter]::Run(45)
