#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace UniMCP4CC.Editor
{
  internal static class McpMenuItemLister
  {
    [Serializable]
    private sealed class MenuItemsPayload
    {
      public string[] menuItems;
      public int count;
    }

    public static string ListMenuItemsBase64(string filter)
    {
      var items = new HashSet<string>(StringComparer.Ordinal);

      foreach (MethodInfo method in TypeCache.GetMethodsWithAttribute<MenuItem>())
      {
        foreach (var attribute in method.GetCustomAttributes(typeof(MenuItem), inherit: false))
        {
          if (attribute is not MenuItem menuItemAttribute)
          {
            continue;
          }

          if (menuItemAttribute.validate)
          {
            continue;
          }

          var menuPath = menuItemAttribute.menuItem;
          if (string.IsNullOrEmpty(menuPath))
          {
            continue;
          }

          if (!string.IsNullOrEmpty(filter) && menuPath.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0)
          {
            continue;
          }

          items.Add(menuPath);
        }
      }

      var payload = new MenuItemsPayload
      {
        menuItems = items.OrderBy(x => x, StringComparer.Ordinal).ToArray(),
        count = items.Count,
      };

      var json = JsonUtility.ToJson(payload);
      return Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
    }
  }
}
#endif
