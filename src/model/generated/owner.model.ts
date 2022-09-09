import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, OneToMany as OneToMany_} from "typeorm"
import * as marshal from "./marshal"
import {Token} from "./token.model"

@Entity_()
export class Owner {
  constructor(props?: Partial<Owner>) {
    Object.assign(this, props)
  }

  @PrimaryColumn_()
  id!: string

  @OneToMany_(() => Token, e => e.owner)
  ownedTokens!: Token[]

  @Column_("numeric", {transformer: marshal.bigintTransformer, nullable: true})
  balance!: bigint | undefined | null

  @Column_("int4", {nullable: true})
  astarCatsBalance!: number | undefined | null

  @Column_("int4", {nullable: true})
  astarDegensBalance!: number | undefined | null

  @Column_("int4", {nullable: true})
  astarSignWitchBalance!: number | undefined | null

  @Column_("int4", {nullable: true})
  astarB2EBalance!: number | undefined | null
}
