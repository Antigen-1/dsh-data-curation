(use-modules (guix profiles)
             (gnu packages)
             (gnu packages autotools)
             (gnu packages base)
             (gnu packages bash)
             (gnu packages gcc)
             (gnu packages guile)
             (gnu packages guile-xyz)
             (gnu packages node)
             (gnu packages pkg-config)
             (gnu packages texinfo))

;; Hoot's own guix.scm uses guile-next and the same propagated Scheme
;; dependencies; this manifest mirrors the build tools for environments
;; where `guix shell -D -f guix.scm` is unavailable.
(packages->manifest
 (list guile-next
       guile-fibers
       guile-gnutls
       guile-websocket
       guile-syntax-highlight
       node
       bash-minimal
       gcc
       autoconf
       automake
       pkg-config
       texinfo
       make))
