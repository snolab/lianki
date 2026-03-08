# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e3]:
    - banner [ref=e4]:
      - generic [ref=e5]:
        - link "Lianki" [ref=e6] [cursor=pointer]:
          - /url: /en
        - navigation [ref=e7]:
          - link "Learn" [ref=e8] [cursor=pointer]:
            - /url: /en/learn
          - link "Blog" [ref=e9] [cursor=pointer]:
            - /url: /en/blog
          - button "Switch language" [ref=e10]:
            - img
          - link "Sign in" [ref=e12] [cursor=pointer]:
            - /url: /en/sign-in
    - main [ref=e13]:
      - generic [ref=e14]:
        - link "Next card" [ref=e16] [cursor=pointer]:
          - /url: /next
        - generic [ref=e17]:
          - heading "Guest Mode" [level=3] [ref=e18]
          - paragraph [ref=e19]: Failed to load local cards. Please make sure the userscript is installed.
          - paragraph [ref=e21]:
            - text: Install the
            - link "Lianki userscript" [ref=e22] [cursor=pointer]:
              - /url: /lianki.user.js
            - text: to use offline mode, or
            - link "sign in" [ref=e23] [cursor=pointer]:
              - /url: /sign-in
            - text: to sync across devices.
  - alert [ref=e24]
```